# Redrob Verifiable Task Spec v1

Spec version identifier: `redrob-verifiable-task/v1`
Status: draft, foundation only. No UI, no model execution.
Machine-checkable half: [`verifiable-task-v1.schema.json`](verifiable-task-v1.schema.json)
Conformance suite: [`conformance/`](conformance/)

## 0. What this is and why

An evaluation set drawn from a fixed list of items stops measuring anything once the list is
in a training corpus. This spec describes the alternative: **parametric generation of tasks
whose answers are checked by a deterministic verifier**. Items are produced fresh from a seed
rather than drawn from a static set, so there is nothing to memorise; and they are scored by
code rather than by a judge model, so the score does not inherit the judge's opinions.

Two properties are load bearing:

1. **Recomputability.** Anyone holding the published generator version, the template, and the
   instance index can regenerate the exact same items, byte for byte, and get the same verdicts.
2. **Cross-implementation agreement.** The declarative verifiers must produce identical verdicts
   in every implementation. This document plus the conformance suite is what makes a second
   implementation safe rather than reckless.

### The two implementations are peers

TypeScript and Python are both reference implementations of this document. **Neither is
authoritative over the other.** When they disagree, this document decides; if this document is
silent, that silence is the bug and it gets fixed here first.

The split of duties is by capability, not by rank:

| Concern | Python | TypeScript |
| --- | --- | --- |
| Template loading and validation | yes | read-only |
| Sampling, rendering, generation | yes | no |
| Declarative verifiers | yes | yes, natively |
| Executable verifiers | yes | **must raise an explicit error** |
| Reading generated sets and manifests | yes | yes |

A TypeScript implementation that quietly skipped an executable verifier and reported success
would produce a silently inflated score. That is the worst failure mode this project has, so
the behaviour is specified as an error, not as a skip, and is covered by a test.

## 1. Documents

Four document kinds, all defined in the JSON Schema.

| Kind | Root in schema | Produced by |
| --- | --- | --- |
| Template | `#` (which is `#/$defs/template`) | a human |
| Instance | `#/$defs/instance` | `redrob-generate emit` |
| Manifest | `#/$defs/manifest` | `redrob-generate emit` |
| Verifier | `#/$defs/verifier` | embedded in templates and instances |

### 1.1 Template

A template is a task *family*: parameter declarations, an optional list of derived values, a
prompt body with placeholders, a locale, and a verifier binding.

```jsonc
{
  "spec_version": "redrob-verifiable-task/v1",
  "id": "math.linear_equation",     // stable across every locale variant
  "version": "1.0.0",
  "locale": "en",
  "family": "math",
  "description": "Solve a linear equation for x.",
  "parameters": [
    { "name": "a", "type": "integer", "min": 2, "max": 9, "exclude": [0] },
    { "name": "b", "type": "integer", "min": -20, "max": 20 }
  ],
  "derivations": [
    { "name": "answer", "expr": "b / a" }
  ],
  "prompt": "Solve for x: {a}x = {b}. Reply with the number only.",
  "verifier": {
    "type": "numeric_tolerance",
    "expected": "{{answer}}",
    "abs_tol": 1e-9
  }
}
```

Note the two distinct brace syntaxes, which is deliberate:

- `{name}` inside `prompt` interpolates a value into human-readable text.
- `{{name}}` inside a verifier binding **replaces the whole JSON leaf** with the typed value.
  `"expected": "{{answer}}"` yields a JSON number, not the string `"2.5"`.

### 1.2 On-disk layout and locales

The Template above is the *merged* form, and it is what gets validated and hashed. On disk a
template family is a directory:

```
templates/<family>/<name>/
  template.json     # locale-neutral core: id, version, family, parameters, derivations, verifier
  locales/en.json   # locale layer: locale, description, prompt, optional notes
  locales/xx.json   # a sibling file, added later, sharing id and parameter declarations
```

Merging is a shallow field-wise overlay of the locale layer onto the core. A locale layer may
only set `locale`, `description`, `prompt` and `notes`; if it tries to redeclare `parameters`,
`derivations`, `id`, `version` or `verifier`, loading fails. That restriction is the whole point
of the split: **translations may change the wording, never the task**. Two locales of the same
template id sample the same parameters from the same seed and expect the same answer, which is
what makes their token counts comparable (see §8).

A single merged `.json` file that already contains every field is also accepted, for tests and
for one-off templates.

### 1.3 Instance

An instance is a template plus bound parameter values plus the derived seed plus the expected
result, computed at generation time. It also carries the content hash of the template it came
from, so a set cannot be silently re-pointed at an edited template.

### 1.4 Manifest

Emitted with every generated set as `manifest.json`. Carries: spec version, generator name and
version, tool name and version, creation timestamp, locale, instance count, the id / version /
locale / content hash of every template used, the seed derivation method, the optional fertility
block, and a ready-to-paste BibTeX entry.

`created_at` is the only field that legitimately differs between two otherwise identical runs.
Everything else is a function of the inputs; see §9.

## 2. Seed derivation

```
seed = first 8 bytes of SHA256(generator_version || 0x00 || template_id || 0x00 || instance_index)
       interpreted as a big-endian uint64
```

Encoding, stated precisely so two implementations cannot drift:

- `generator_version` is the generator's semver string, UTF-8 encoded, e.g. `0.1.0`.
- `0x00` is a single NUL byte, used as an unambiguous separator so that no pair of distinct
  field triples can produce the same byte string.
- `template_id` is the template id, UTF-8 encoded. Not the locale, and not the template version:
  every locale of a template samples the *same* parameters.
- `instance_index` is the zero-based index rendered as an ASCII decimal string with no padding
  and no sign, UTF-8 encoded.
- The uint64 is written into JSON as a **decimal string**, because a uint64 does not survive a
  round trip through an IEEE-754 double.

Worked example, checkable by hand with `sha256sum`:

```
generator_version = "0.1.0", template_id = "math.linear_equation", instance_index = 0
message  = 30 2e 31 2e 30 | 00 | "math.linear_equation" | 00 | 30
seed     = uint64_be(sha256(message)[0:8])
```

The frozen fixture `conformance/seed-fixture.json` pins a table of these values and is executed
by both test suites.

### 2.1 Why not seed 42

A fixed conventional seed such as 42 makes seed selection unverifiable. A reader cannot
distinguish a single honest run from the best of several runs, because nothing in the published
artefact ties the seed to the content. The temptation is structural, not moral: with a free
parameter that nobody can audit, the incentive is to try a few and report the good one.

A content-derived seed removes the free parameter. Any third party can recompute the seed from
the published generator version and template id, so a set generated from a different seed is
detectable by inspection rather than by trust. **Cherry-picking becomes structurally impossible
rather than merely discouraged.** The same argument is why the template content hash travels in
both the instance and the manifest: it closes the remaining gap of editing the template and
keeping the seed.

## 3. Sampling

Sampling is generation-side, so it only has to be deterministic, not cross-language. It is
specified anyway, so that a future implementation in another language produces identical sets.

### 3.1 PRNG

SplitMix64, seeded with the derived uint64. All arithmetic is modulo 2^64.

```
state = seed
next_u64():
    state = (state + 0x9E3779B97F4A7C15) mod 2^64
    z = state
    z = ((z XOR (z >> 30)) * 0xBF58476D1CE4E5B9) mod 2^64
    z = ((z XOR (z >> 27)) * 0x94D049BB133111EB) mod 2^64
    return z XOR (z >> 31)
```

Chosen over a language's built-in RNG because it is eight lines of arithmetic that any
implementation can reproduce exactly, with no dependence on a standard library's internals.

One stream per instance, consumed by parameters in **declaration order**. Reordering the
`parameters` array therefore changes the generated set; that is intended, and is why a template
edit changes the content hash.

### 3.2 Draws

- **Unbiased integer in `[lo, hi]`**: with `range = hi - lo + 1` and
  `limit = 2^64 - (2^64 mod range)`, draw `x = next_u64()` until `x < limit`, return
  `lo + (x mod range)`. Rejection rather than plain modulo, so the distribution does not tilt
  toward small values for large ranges.
- **`number`**: `f = (next_u64() >> 11) / 2^53` giving a value in `[0, 1)`, then
  `v = lo + f * (hi - lo)`. If `decimals` is set, `v = floor(v * 10^d + 0.5) / 10^d`, which is
  round-half-away-from-zero for positive values and is written out explicitly because language
  built-ins disagree about halves.
- **`boolean`**: `next_u64() & 1 == 1`.
- **`choice`**: index drawn as an unbiased integer in `[0, n - 1]`.
- **`subset`**: Fisher-Yates shuffle of the index list (descending `i` from `n-1` to `1`, with
  `j` an unbiased integer in `[0, i]`), take the first `size` indices, then sort those indices
  ascending so the result is order-independent.
- **`permutation`**: the same Fisher-Yates shuffle, all elements, order preserved.
- **`exclude`**: after a draw, if the value is in `exclude`, discard and draw again. Capped at
  1000 attempts, after which loading fails loudly rather than looping.

## 4. Derivations

`derivations` is an ordered list of `{ name, expr }`. Each expression is evaluated in a
restricted language with parameters and earlier derivations in scope, and its result is bound
under `name`. Derivations are how a template computes its own ground truth: the answer to the
equation, the planted facts inside a synthetic document, the reference JSON.

The language is **generation-side only**. TypeScript never evaluates it, because TypeScript
never generates. It is a whitelisted subset of Python expression syntax:

- Literals; names bound to parameters or earlier derivations.
- Arithmetic `+ - * / // % **`, unary `+ -`, comparisons, `and` / `or` / `not`,
  conditional expressions, subscripting and slicing.
- List, tuple, dict and set displays; single-generator list comprehensions with an optional
  `if`; f-strings with constant format specs.
- Calls to a fixed function whitelist only: `abs, all, any, bool, canonical_json, dict, divmod,
  enumerate, float, format, int, join, len, list, lower, max, min, pow, range, replace, round,
  sorted, str, strip, sum, title, upper, zip`. `join`, `lower`, `upper`, `strip`, `replace` and
  `title` are free functions here, e.g. `join(", ", names)`, because attribute access is not
  permitted. `canonical_json` produces the §9.1 serialisation, which is what a template uses when
  it wants to state the exact string a model is expected to emit.

Everything else - attribute access, assignment, lambdas, imports, comprehensions with multiple
generators, and any name not in the whitelist - is a load-time error. There is no `eval` of
arbitrary code and no import machinery, so a template cannot reach the filesystem or the network.

## 5. Rendering

`prompt` is rendered by scanning left to right:

- `{{` emits a literal `{`, `}}` emits a literal `}`.
- `{name}` looks `name` up in the merged scope of parameters and derivations. An unknown name is
  an error; the generator never emits a prompt with an unresolved placeholder.
- Values are rendered as: `true` / `false` for booleans; the decimal integer for integers; the
  shortest round-trip representation for floats; the string itself for strings; elements joined
  with `", "` for lists; and canonical JSON (§9.1) for anything else.
- A bare `{` or `}` that is not part of the above is an error, so that a typo fails loudly
  instead of shipping a malformed prompt.

Verifier bindings are resolved separately. Any string leaf of the verifier object that is
exactly `{{name}}` is replaced by the *typed* value of `name`. A string leaf that merely
contains `{{name}}` among other text is substituted textually. This is what lets a template
declare `"expected": "{{answer}}"` and get a number, or a whole JSON schema object, out the
other side.

## 6. Verifiers

Every verifier returns a **Verdict**: `{ passed, code, message?, detail? }`.

`passed` and `code` are **normative**. Two implementations that agree on `passed` but disagree
on `code` have diverged, and the conformance suite fails them. `message` and `detail` are
advisory, exist for humans, and are explicitly not compared.

The code vocabulary is closed; see `#/$defs/verdict_code`.

### 6.0 Shared definitions

**Spec whitespace** is the explicit set

```
U+0009 U+000A U+000B U+000C U+000D U+0020 U+0085 U+00A0 U+1680
U+2000..U+200A U+2028 U+2029 U+202F U+205F U+3000
```

It is written out rather than delegated to `\s` or `isspace()`, because those differ between
Python and JavaScript. Wherever this document says trim, strip or collapse whitespace, it means
this set.

**Line ending normalisation** rewrites `\r\n` and then lone `\r` to `\n`. Nothing else is a line
terminator for this purpose, including `\u2028` and `\u2029`.

**Length** is counted in Unicode **code points**, not UTF-16 code units. An implementation on a
UTF-16 runtime must iterate code points; `"👍".length === 2` is the wrong answer, the answer is 1.

**Line count** of a text: normalise line endings if the verifier says so, split on `\n`; if the
result has more than one element and the last is empty, drop that last element; the empty string
has 0 lines.

### 6.1 Declarative tier

Eight types: seven leaf checks plus one composition. Every implementation must support all
eight, and must agree on every one.

#### `exact`

String equality after a normalisation pipeline applied identically to both the candidate and the
expected value, in this fixed order:

1. `unicode_normalization` - one of `none` (default), `NFC`, `NFD`, `NFKC`, `NFKD`
2. `normalize_line_endings` (default `false`)
3. `trim` (default `false`)
4. `collapse_whitespace` (default `false`) - each run of spec whitespace becomes one `U+0020`
5. lowercasing when `case_sensitive` is `false` (default `true`), using the default Unicode
   lowercase mapping (`str.lower()` / `String.prototype.toLowerCase()`), **not** full case folding

Codes: `ok`, `mismatch`.

#### `numeric_tolerance`

The candidate is parsed as exactly one number. Grammar, applied after optional trimming
(`trim`, default `true`) and after removing ASCII commas when `allow_thousands_separator`:

```
number   := sign? ( digits ( '.' digits? )? | '.' digits ) exponent?
          | sign? ('nan' | 'inf' | 'infinity')        // ASCII case-insensitive
sign     := '+' | '-'
exponent := ('e' | 'E') sign? digits
```

Anything else, including an empty string, trailing text, hex, or underscores, yields
`not_a_number`. Comparison, in order:

1. Either side NaN: pass only if both are NaN **and** `nan_matches_nan` is true. Otherwise
   `nan_mismatch`.
2. Either side infinite: pass only if both are infinite with the same sign. Otherwise
   `infinity_mismatch`.
3. Otherwise pass iff `|c - e| <= max(abs_tol, rel_tol * |e|)`. Otherwise `out_of_tolerance`.

Both tolerances default to `0`, so the default is exact equality of two doubles. Note that
`rel_tol` against an expected value of `0` degenerates to `abs_tol`, which is why the two are
combined with `max` rather than one being chosen.

Codes: `ok`, `not_a_number`, `nan_mismatch`, `infinity_mismatch`, `out_of_tolerance`.

#### `json_schema`

The candidate is parsed as JSON (`invalid_json` on failure) and validated against
`schema` (`schema_violation` on failure).

The schema is a JSON Schema draft 2020-12 document, restricted to the keyword subset below. The
restriction exists because the Python implementation uses the full `jsonschema` library while
the TypeScript implementation carries no JSON Schema dependency; the subset is the region where
the two are known to agree, and the conformance suite is what keeps that claim honest.

Supported: `type` (including a list of types), `enum`, `const`, `$ref` restricted to local
`#/$defs/...` pointers, `$defs`, `allOf`, `anyOf`, `oneOf`, `not`, `properties`,
`patternProperties`, `additionalProperties`, `required`, `minProperties`, `maxProperties`,
`propertyNames`, `dependentRequired`, `items`, `prefixItems`, `minItems`, `maxItems`,
`uniqueItems`, `contains`, `minContains`, `maxContains`, `minLength`, `maxLength`, `pattern`,
`minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, and the boolean
schemas `true` / `false`.

Not supported, and rejected at load time rather than ignored: `$dynamicRef`, `$dynamicAnchor`,
remote `$ref`, `if` / `then` / `else`, `dependentSchemas`, `unevaluatedProperties`,
`unevaluatedItems`, `format` as an assertion, and `contentEncoding` / `contentMediaType`.

Further clarifications, each of which is a real divergence risk:

- `pattern` and `patternProperties` keys use the same restricted regex subset as the `regex`
  verifier (§6.1 `regex`), with `search` semantics.
- `type: "integer"` matches an integral value, including `2.0`.
- `multipleOf` is evaluated as `value / multipleOf` being integral, with a relative slack of
  `1e-9` to absorb binary floating point.
- `uniqueItems` compares by structural deep equality, where `1` and `1.0` are the same value and
  `1` and `true` are not.
- Object key ordering never affects validation.

Codes: `ok`, `invalid_json`, `schema_violation`.

#### `regex`

**The normative semantics are Python `re` semantics with the `re.ASCII` flag.** A JavaScript
implementation must rewrite the pattern to reproduce them, because the two engines disagree in
at least four places that matter. This is stated as a direction of translation rather than as a
"be careful" note, because a "be careful" note is not testable.

Configuration: `pattern`, `mode` (`full_match` default, or `search`), and `flags`, a subset of
`i`, `m`, `s`. No other flag is portable and no other flag is accepted.

Supported syntax: literal characters; `.`; character classes `[...]` with ranges, negation and
escapes; the escapes `\d \D \w \W \s \S \b \B \n \r \t \f \v \0` and any punctuation escape;
quantifiers `* + ? {m} {m,} {m,n}` with the lazy `?` suffix; groups `( )`, `(?: )`, `(?= )`,
`(?! )`; alternation `|`; anchors `^` and `$`.

Rejected with `invalid_pattern`: backreferences, named groups, lookbehind, atomic groups and
possessive quantifiers, inline flag groups `(?i)`, `\A \Z \z \G`, `\p{...}` and `\P{...}`,
`\S` inside a character class, and any malformed pattern.

The four divergences and how they are resolved:

| Construct | Python `re` + `re.ASCII` | Plain JavaScript | Resolution |
| --- | --- | --- | --- |
| `.` without `s` | any char except `\n` | also excludes `\r \u2028 \u2029` | JS rewrites `.` to `[^\n]`, or `[\s\S]` with `s`, and never passes the JS `s` flag |
| `$` without `m` | end, or before a single trailing `\n` | end only | JS rewrites `$` to `(?=\n?$)` |
| `^` / `$` with `m` | around `\n` only | also around `\r \u2028 \u2029` | JS rewrites to `(?:^\|(?<=\n))` and `(?=\n\|$)`, and never passes the JS `m` flag |
| `\d \w \b \s` | ASCII-only under `re.ASCII` | ASCII for `\d \w \b`, Unicode for `\s` | JS rewrites `\s` to `[ \t\n\r\f\v]` and `\S` to `[^ \t\n\r\f\v]` |

Two consequences are out of subset and are not covered by any guarantee: the `i` flag over
characters whose simple and full case foldings differ (`ß`, `ﬀ`), and quantified `.` spanning
astral characters, which a UTF-16 engine counts as two units and Python counts as one.

Codes: `ok`, `no_match`, `invalid_pattern`.

#### `set_equality`

The candidate string is split into elements by `parse`:

- `json_array` - parse the candidate as JSON, which must be an array (`parse_error` otherwise)
- `lines` - normalise line endings, split on `\n`
- `delimiter` - split on the literal `delimiter`

then `trim_elements` (default `true`) and `drop_empty` (default `true`) are applied.
`element_comparator` is one of `exact_string`, `case_insensitive_string`, `numeric` (parsed by
the `numeric_tolerance` grammar, with `numeric_abs_tol` / `numeric_rel_tol`), or `json`
(structural deep equality).

`duplicates` is `collapse` (default) or `significant`. Under `collapse` both sides are
deduplicated first, using the comparator's *canonical key* and ignoring numeric tolerance;
tolerance is still applied when matching. Under `significant` the two sides are compared as
multisets.

Comparison order: parse, then deduplicate if applicable, then compare lengths
(`cardinality_mismatch`), then match greedily - for each expected element in order, take the
first not-yet-matched candidate element that compares equal; an expected element with no match
gives `element_mismatch`.

Codes: `ok`, `parse_error`, `cardinality_mismatch`, `element_mismatch`.

#### `ordered_equality`

Identical to `set_equality` except that duplicates are always significant and elements are
compared pairwise by position. Length first (`cardinality_mismatch`), then position order
(`element_mismatch`).

Codes: `ok`, `parse_error`, `cardinality_mismatch`, `element_mismatch`.

#### `format_constraint`

Shape only; it never looks at meaning. After optional `normalize_line_endings` (default `true`)
and `trim` (default `false`), the checks run in this fixed order, and the **first** failure is
the reported code:

1. `min_length` / `max_length`, in code points → `length_out_of_bounds`
2. `min_lines` / `max_lines`, by the §6.0 line count → `line_count_out_of_bounds`
3. `required_substrings`, in declaration order → `missing_required_substring`
4. `forbidden_substrings`, in declaration order → `forbidden_substring_present`

`case_sensitive` (default `true`) applies to the substring checks only. Every field is
optional; a verifier with no fields set passes everything, which is a legitimate way to say
"any output is structurally acceptable".

Codes: `ok`, `length_out_of_bounds`, `line_count_out_of_bounds`,
`missing_required_substring`, `forbidden_substring_present`.

#### `all_of`

Composition. `verifiers` is an ordered list of declarative verifiers; each is run in turn against
the same candidate, and the **first failing verdict is returned verbatim**, code and all. An
empty list passes, which is the identity element and a legitimate way to say "no constraint".

Children must be declarative. An executable child is a configuration error, because `all_of` is
declarative by definition and a composite that is declarative on one implementation and
unsupported on another would be the exact silent-skip hazard this spec exists to prevent.
Nesting is allowed to a depth of 8.

Order matters and is the point: put the check whose failure is most diagnostic first. A template
that wants both "the extracted values are right" and "the serialisation is right" should run
`json_schema` before `exact`, so that a wrong answer reports a schema violation rather than a
string mismatch.

Codes: `ok`, plus any code a child can produce.

### 6.2 Executable tier

Two types, Python only.

- **`sympy_equiv`** - parse the candidate and the expected expression with SymPy over a declared
  symbol list and test symbolic equivalence, by simplifying the difference to zero
  (`simplify_zero`) or by SymPy's own `equals` (`equals`). Declaring `symbols` is required in
  practice, because otherwise an undeclared name silently becomes a new free symbol and the
  comparison quietly means something else.
- **`python_unittest`** - write the candidate to a module and run supplied `unittest` source
  against it under a timeout.

Both execute code derived from a model's output. They are not sandboxed by this spec and must
not be run on untrusted content without an external sandbox.

**A non-Python implementation must raise an explicit unsupported-verifier error on both types.**
Not a skip, not a pass, not a warning. The TypeScript implementation raises
`UnsupportedVerifierError`; when it is asked for a verdict rather than an exception, it returns
`{ passed: false, code: "unsupported_verifier" }`. Either way the item cannot be counted as
correct. This is asserted by a test in both suites.

## 7. Bridging

The Python CLI is the **only** bridge boundary. A non-Python implementation that needs an
executable verifier runs `redrob-generate verify` as a subprocess and exchanges JSON on stdin
and stdout. There is no HTTP service and no other IPC mechanism, because every additional
channel is another place the two sides can drift, and because a subprocess needs no ports, no
auth and no lifecycle.

A caller must degrade with a clear message when Python is absent, rather than throwing an
unhandled error. Generation is optional; the workbench works without it.

## 8. Fertility hook

An implementation may attach token counts to each instance under a named tokenizer, recording
`tokenizer_name` and `tokenizer_version` in both the instance and the manifest.

No tokenizer ships with the generator and none is chosen here. The hook is an interface, and a
run without one simply omits the field.

The reason this belongs in the spec rather than in a downstream analysis script: **because
generated items carry identical semantic content across locales, their token counts are directly
comparable.** Corpus-level fertility statistics are not, because they conflate the tokenizer with
whatever the corpus happens to talk about. Here the parameters, the seed and the expected answer
are the same across locales by construction, and only the surface wording differs, so the ratio
between two locales' token counts is a measurement of the tokenizer rather than of the corpus.

## 9. Determinism

`redrob-generate emit`, run twice with the same inputs, must produce byte-identical output,
including the manifest, with `created_at` excluded.

Rules that make that true:

- No network access at generation or verification time, for any reason. Determinism cannot
  survive a dependency on something that can change or be unavailable. Both test suites assert
  this by failing if a socket is opened.
- No clock reads other than `created_at`, and no environment reads other than explicit CLI
  arguments.
- No iteration over unordered collections in a way that reaches the output. Emitted JSON is
  written with sorted keys.
- Files are written with `\n` endings, UTF-8, no BOM, and a single trailing newline.

### 9.1 Canonical JSON

Used for content hashing and for the emitted files:

- Object keys sorted by Unicode code point, ascending.
- No insignificant whitespace: `,` and `:` separators with no spaces.
- Strings escaped as JSON requires and no further: the short escapes for `\b \t \n \f \r \" \\`,
  `\u00XX` for the remaining C0 controls, and every other character emitted literally.
- Numbers formatted by the **ECMAScript `Number::toString` algorithm**. Shortest round-trip
  digits, exponent notation only when the decimal exponent is below `-6` or at least `21`, and
  the exponent itself written without a leading zero.

  This is stated as an algorithm rather than as "shortest round-trip form" because the two
  runtimes present the same digits differently: Python's `repr` writes `1e-09` where JavaScript
  writes `1e-9`, and Python switches to exponent notation at `1e16` where JavaScript waits until
  `1e21`. A Python implementation must reimplement the ECMAScript presentation rules; the digits
  themselves already agree.
- **Restriction:** an integer outside the safe double range, `±(2^53 - 1)`, is rejected rather
  than serialised, because a JavaScript reader would silently see a different number and
  therefore compute a different hash.

Content hash: `sha256:` followed by the lowercase hex SHA-256 of the UTF-8 canonical JSON of the
merged template document.

## 10. Conformance

`spec/conformance/` holds one JSON file per declarative verifier type, each a
`#/$defs/conformance_file`. Every case is `{ id, verifier, candidate, expected }` where
`expected` is `{ passed, code }`.

Both implementations run the same files. The suite deliberately includes empty strings, Unicode
including Devanagari and Hangul, floating point edge cases, NaN and infinities, deeply nested
JSON, regex metacharacters, and mixed line endings, because those are exactly the places two
engines drift apart. Any divergence fails CI.

`conformance/seed-fixture.json` pins the seed derivation, and `conformance/canonical-json.json`
pins canonical JSON serialisation. Both are executed by both suites.

## 11. Versioning

The spec version identifier changes only on a breaking change to document shapes or to verifier
semantics. A new verifier type, a new optional field, or a new verdict code is additive and does
not change it, but it does require a conformance file before it may be used.

## 12. Licence

Apache-2.0, same as the repository. The spec text may be reimplemented freely; a reimplementation
that passes `spec/conformance/` may describe itself as conforming to Redrob Verifiable Task
Spec v1.
