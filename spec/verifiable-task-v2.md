# Redrob Verifiable Task Spec v2

> ## ⚠ DRAFT — NOT STABLE, DO NOT CITE THIS BRANCH
>
> **This surface may change, including in ways that break existing templates and generated
> sets, until the accompanying preprint is released.** The version identifier
> `redrob-verifiable-task/v2` does not yet imply stability; it names the shape of the
> document, not a promise about it.
>
> **Pin a commit.** Anyone implementing against this specification, generating a set they
> intend to publish, or citing it in written work should reference an exact commit SHA and
> not the branch. Tracking the branch means your verdicts can change under you between one
> checkout and the next, which defeats the recomputability this document exists to provide.
>
> Changes already made after the first draft was written, as examples of the scale still
> possible: the regex subset lost `\w`, `\d`, `\b`, `.` and `$` outright; string comparison
> gained a required normalisation form; and `all_of` was removed outright in favour of a
> list-valued verifier field (§11.1). Every one was a correction, and every one would have
> invalidated a published set.
>
> The intended stability point is the preprint. At that point this notice is replaced by a
> statement of what is frozen and what is not. Until then, the record of what is unresolved
> and why is under
> [`docs/decisions/`](../docs/decisions/).

Spec version identifier: `redrob-verifiable-task/v2`
Status: **draft**, foundation only. No UI, no model execution.
Machine-checkable half: [`verifiable-task-v2.schema.json`](verifiable-task-v2.schema.json)
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

That parity is about conformance, not about publication. **Python is normative for any verdict
that is going to be published: every verdict record carries the implementation that produced it,
that implementation's version and the version of the Unicode table it read, and a publishable
artifact refuses to build from a verdict this project's Python implementation did not produce.**
The reason is not that TypeScript is less correct — it passes the same corpus — but that the two
runtimes compile against different versions of the Unicode Character Database, so a normalisation
or case mapping over a recently assigned code point can differ while both behave correctly.

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
  "spec_version": "redrob-verifiable-task/v2",
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
  locales/en.json   # locale layer: locale, translation_status, description, prompt, optional notes
  locales/xx.json   # a sibling file, added later, sharing id and parameter declarations
```

Merging is a shallow field-wise overlay of the locale layer onto the core. A locale layer may
only set `locale`, `translation_status`, `description`, `prompt` and `notes`; if it tries to
redeclare `parameters`, `derivations`, `id`, `version` or `verifier`, loading fails. That
restriction is the whole point of the split: **translations may change the wording, never the
task**. Two locales of the same template id sample the same parameters from the same seed and
expect the same answer, which is what makes their token counts comparable (see §8).

Resolving a template id and a locale to a concrete template either succeeds or fails loudly.
There is no fallback to another locale: a missing `xx.json` is an error naming the locales that
do exist, because silently serving English under a Korean label would make a per-locale
measurement meaningless in exactly the way that is hardest to notice afterwards.

`translation_status` is required on every locale layer and is one of `native-reviewed`,
`single-reviewer` or `untranslated`. It has no default, because every candidate default is a
false statement about work that either did or did not happen. `untranslated` marks a placeholder
— in practice the English prompt copied verbatim — which exists so that a pipeline can be
exercised across locales before any translation is commissioned. Such a template loads, generates
and scores normally; what it cannot do is be published. A publishable artifact refuses to build
while any locale it covers is `untranslated`.

A single merged `.json` file that already contains every field is also accepted, for tests and
for one-off templates.

### 1.3 Instance

An instance is a template plus bound parameter values plus the derived seed plus the expected
result, computed at generation time. It also carries the content hash of the template it came
from, so a set cannot be silently re-pointed at an edited template.

It also carries `code_mix_ratio`, which is required and is currently always `null`. The field
names the proportion of a prompt drawn from the embedded language in a code-mixed locale such as
`hi-Latn`. No implementation computes it, and none should until the measurement is defined:
choosing a token unit, a language identifier and a treatment of proper nouns and numerals each
change the number for the same sentence, so any value produced today would be an artefact of
those unstated choices. It is present rather than absent so that the document shape does not
change when the method is settled, and `null` rather than omitted so a reader can tell "not
measured" from "written by an older tool".

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

**Line count** of a text: normalise line endings if the verifier says so, split on `\n`; if the
result has more than one element and the last is empty, drop that last element; the empty string
has 0 lines.

#### Unicode normalisation

Every verifier that compares strings carries a `normalization` field, one of `NFC` (**default**),
`NFD`, `NFKC`, `NFKD`, `none`. The declared form is applied to the candidate **and** to the
expected value, before any other step, so that a comparison never depends on which composition
form a tokeniser happened to emit.

The default is `NFC` rather than `none`, and that is a deliberate choice about what a benchmark is
measuring. Hangul `가` is U+AC00 precomposed and U+1100 U+1161 as conjoining jamo; the two render
identically and no reader can tell them apart. Devanagari nukta forms and Latin combining accents
have the same property. Without normalisation, two models that produced the same visible answer
score differently because of their tokeniser's internal preference, which is not a capability
difference and must not be reported as one.

`none` exists for the case where byte exactness is the thing under test — a serialisation format,
a hash input, a round-trip — and must be requested explicitly. It is not the default precisely
because the failure it produces is invisible: the two strings look the same in every log, diff and
terminal that will ever display them.

`NFC` is the only form for which the two reference implementations are known to agree on the whole
code point range. Python's `unicodedata` and a JavaScript runtime's ICU are versioned
independently, and the compatibility and decomposition forms differ for characters assigned in
whichever Unicode version one side has and the other does not; `NFC` is stable across those
assignments and the others are not. `NFD`, `NFKC` and `NFKD` are specified and implemented, and a
template using one accepts that its scores are only reproducible where both runtimes carry the
same Unicode version. See `docs/decisions/0002-unicode-semantics.md` for the measurement.

Normalisation applies to **strings inside a parsed JSON instance too, keys as well as values**.
`{"\uAC00": 1}` and `{"\u1100\u1161": 1}` are the same object to a reader, so they must be the same
object to `required`, `properties` and `propertyNames`.

#### Length units

Every verifier that bounds a length carries a `length_unit` field:

| Value | Meaning | Why it is not the default |
| --- | --- | --- |
| `codepoints` | Unicode scalar values (**default**) | — |
| `utf16` | UTF-16 code units, i.e. `String.prototype.length` | Runtime-specific; astral characters count twice |
| `bytes_utf8` | Bytes in the UTF-8 encoding | A transport bound, not a text bound |
| `graphemes` | UAX #29 extended grapheme clusters | **Refused.** See below |

There is no unit that is simply correct. `नमस्ते` is six code points, six UTF-16 units, eighteen
UTF-8 bytes and four grapheme clusters; `😀` is one code point, two UTF-16 units and four bytes.
`codepoints` is the default because it is the only one of the three supported units that is a
property of the text rather than of a runtime or a transport.

`graphemes` is what a human means by "length", it is in the value list, and both implementations
**refuse it with an error rather than approximating it**. Grapheme breaking is defined by UAX #29
against a specific Unicode version, and the two runtimes here do not carry the same one: Python's
`unicodedata` and Node's ICU differ, and they differ on exactly the emoji and conjunct sequences a
grapheme count exists to get right. Two breakers drawn from different tables would produce two
lengths, one of them would silently score a model, and no test comparing the two implementations
against a corpus written in either Unicode version would see it. An error is the only answer that
cannot be quietly wrong. Reinstating the unit requires pinning one Unicode version for both
runtimes, which is a dependency decision, not a spec decision.

Substring checks are normalisation-sensitive in the same way and for the same reason: the needle
goes through the verifier's declared form before it is looked for, so a required substring written
in one composition form is found in the other.

#### Verifier configuration must be well-formed Unicode

**No string anywhere in a verifier's configuration may contain an unpaired surrogate.** A
configuration that does is refused with a configuration error before anything is evaluated, and
the rule is enforced once at dispatch so that a field added later inherits it.

U+D800..U+DFFF are not characters. They exist so that UTF-16 can encode the astral planes, and a
JSON document can name one directly with a `\uD83D` escape. What the two runtimes then do with it
is not the same thing. A JavaScript string is a sequence of UTF-16 code units, so `\uD83D` really
is the first half of `😀` and `"😀".includes("\uD83D")` is **true**; a Python string is a sequence
of code points, so `"\ud83d" in "\U0001f600"` is **false**. The same split runs through
`String.prototype.split` against a lone-surrogate delimiter, which cuts an emoji in two on one
runtime and matches nothing on the other. Both engines are behaving correctly according to their
own model of a string; there is no reading of the input on which they agree, so there is nothing
for this spec to pin.

**Candidates are not subject to this rule.** A candidate is model output and must always yield a
verdict rather than an error, and an unpaired surrogate in a candidate is harmless by itself: the
divergence needs the *needle* to be half of a pair, not the haystack.

### 6.1 Declarative tier

Seven types, all of them leaf checks. Every implementation must support all seven, and must agree
on every one. Composition is not a type; it is a shape of the verifier field, described in §6.2.

#### `exact`

String equality after a normalisation pipeline applied identically to both the candidate and the
expected value, in this fixed order:

1. `normalization` - one of `NFC` (default), `NFD`, `NFKC`, `NFKD`, `none`, per §6.0
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

The candidate is parsed as JSON (`invalid_json` on failure), every string and object key in the
result is normalised to the verifier's declared `normalization` form (§6.0, default `NFC`), and
the result is validated against `schema` (`schema_violation` on failure).

**The schema itself is not normalised; it is required to be already in the declared form**, and a
schema that is not is refused as a configuration error. Rewriting it would be the more forgiving
choice and it is the wrong one: a `const` written in NFD under a verifier declaring NFC can never
match anything, and that is a bug in the template rather than a property of the answer. Refusing
it says so at load time; rewriting it would make the template mean something its author did not
write. The check skips `pattern` and `patternProperties` keys, whose contents are regex source
rather than text to be compared.

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
  verifier (§6.1 `regex`), with `search` semantics, and with the one difference described under
  "`^` and `$` live only in a JSON Schema pattern" below: the two anchors are permitted here.
- `minLength` and `maxLength` count **code points**, per JSON Schema draft 2020-12, which is the
  `codepoints` unit of §6.0 and not a runtime's string length.
- `type: "integer"` matches an integral value, including `2.0`.
- `multipleOf` is evaluated as `value / multipleOf` being integral, with a relative slack of
  `1e-9` to absorb binary floating point.
- `uniqueItems` compares by structural deep equality, where `1` and `1.0` are the same value and
  `1` and `true` are not.
- Object key ordering never affects validation.

Codes: `ok`, `invalid_json`, `schema_violation`.

#### `regex`

**The subset contains no construct whose meaning depends on which engine reads it.** That is the
entire design rule, and every restriction below follows from it. Implementations compile the
pattern verbatim: there is no translation between dialects, because a translator is a second
implementation of regex semantics and it would need its own conformance suite to be trustworthy.

Configuration: `pattern` and `mode` (`full_match` default, or `search`). **There are no flags.**

Supported syntax: literal characters; character classes `[...]` with ranges, negation and
escapes; the escapes `\n \r \t \f \v`, `\xHH`, `\uHHHH`, and the escaped punctuation
`^ $ \ . * + ? ( ) [ ] { } | /` plus `-` inside a class; quantifiers `* + ? {m} {m,} {m,n}` with
the lazy `?` suffix; groups `( )`, `(?: )`, `(?= )`, `(?! )`; alternation `|`.

A pattern is matched **by code point**, not by UTF-16 code unit. A JavaScript implementation must
compile with the `u` flag; a Python implementation gets this for free. `[\u0000-\uffff]` therefore
means "one BMP character" on both sides, `😀` is one atom on both sides, and a quantifier applied
to a class counts astral characters once rather than twice. Surrogate code points, and the escapes
`\uD800`–`\uDFFF` that would name them, are rejected: they have no meaning as text and the two
engines disagree about whether they are even expressible.

##### The shorthand classes are forbidden

`\w \W \d \D \b \B \s \S` are rejected with `invalid_pattern`, and rejected again at template
load time so that a bad pattern is found before a set is generated rather than after it is
published. Write the character class out: `[0-9]`, `[A-Za-z0-9_]`, `[\u0900-\u097F]`.

They are forbidden because they are Unicode-aware in Python and ASCII-only in a JavaScript
`RegExp` without the `u` flag. Either reading is defensible and neither is portable, so an
earlier revision of this spec pinned the ASCII reading and had the JavaScript side rewrite
patterns to match. **That was the wrong choice.** ASCII semantics say that Devanagari has no word
characters, that `०१२` are not digits, and that there is no word boundary anywhere in a Hangul
string. For a benchmark whose targets are Hindi, Hinglish and Korean, a `\w` that silently means
"Latin only" is not a portability compromise, it is a wrong answer that looks like a working
pattern. An explicit class cannot make that mistake quietly.

##### `.`, `^` and `$` are forbidden for the same reason

| Construct | Python `re` | JavaScript `RegExp` |
| --- | --- | --- |
| `.` | any character except `\n` | also excludes `\r`, U+2028, U+2029 |
| `$` without `m` | end of string, or before one trailing `\n` | end of input only |
| `^` and `$` with `m` | around `\n` only | also around `\r`, U+2028, U+2029 |

None of these differences is expressible as a flag, so keeping the constructs would mean keeping a
translator. Instead: write `[^\n]` where you meant `.`, or `[\u0000-\uffff]` for any BMP character
and `[\u0000-\U0010ffff]` for any character at all; and use `mode` where you meant to anchor.
`full_match` requires the pattern to consume the entire input and `search` does not, which is the
whole of what the two anchors were being used for.

An earlier revision of this spec kept `^`, and spelled end of input as `(?![\u0000-\uffff])` where
`mode` was not available. **That was wrong, and wrong in a way two implementations agreed on.** In
Python a string is code points, so an astral character is outside the class, the lookahead
succeeds and `^foo(?![\u0000-\uffff])` matches `foo😀`. In a JavaScript `RegExp` without `u` the
string is UTF-16, the lead surrogate is inside the class, the lookahead fails and the same pattern
rejects the same input. Both engines were doing exactly what their own model of a string says, the
conformance corpus contained no astral characters, and the divergence was invisible for as long as
that stayed true. The construct is gone and so is the ambiguity it needed: the subset now fixes
code-point matching, and anchoring is a field rather than syntax.

##### `^` and `$` live only in a JSON Schema pattern

`^...$` is how everyone writes an anchored JSON Schema `pattern`, there is no `mode` field to move
the intent into, and a subset that forbids it would be ignored. So the two anchors are permitted
inside `pattern` and `patternProperties`, and `$` is defined normatively as **the absolute end of
input** — never before a trailing newline. A JavaScript `RegExp` without `m` already means that.
Python's `$` does not, so a Python implementation rewrites that single token to `\Z`.

That rewrite is one token, in one dialect, and it is not a reinstatement of the general pattern
translator this spec removed. The distinction is that the translator had to model each engine's
reading of `.`, `^`, `$`, `\s` and the flags, so it was a second implementation of regex semantics
and needed its own conformance suite to be trusted; this is a substitution of one fixed token for
one fixed token, visible in a single line, with the corpus row
`json_schema/pattern-dollar-excludes-a-trailing-newline` failing the moment it stops happening.
The reasoning is recorded in `docs/decisions/0002-unicode-semantics.md`.

##### There are no flags, and case-insensitive matching is gone with them

Case folding is the last construct on which the engines disagree, and no configuration of the two
makes them agree. Under the code-point model this subset now requires, Python's `re.IGNORECASE`
folds U+212A KELVIN SIGN to `k` and U+0131 LATIN SMALL LETTER DOTLESS I to `i`; a JavaScript
`RegExp` with `iu` folds the Kelvin sign and does **not** fold the dotless i. There is no flag
combination that reconciles them, and the earlier compromise of confining `i` to ASCII patterns
died with `re.ASCII`, which was only there to make the shorthand classes portable.

Write the alternation out: `[aA][bB][cC]`. It is longer, it is exact, and it cannot mean two things
in two runtimes. Nothing is lost for this specification's target scripts, because Devanagari and
Hangul are caseless.

`m`, `s`, `g` and `u` are likewise not configurable: `m` and `s` had nothing left to modify once
`^`, `$` and `.` were gone, `g` is meaningless for a single match, and `u` is mandatory rather than
optional. `flags` is not a field.

Also rejected with `invalid_pattern`: backreferences, named groups, lookbehind, atomic groups and
possessive quantifiers, inline flag groups `(?i)`, `\A \Z \z \G`, `\p{...}` and `\P{...}`, the
octal-looking `\0` (write `\x00`), a quantifier applied to a lookahead, an escaped character
outside the permitted punctuation set, and any malformed pattern.

Codes: `ok`, `no_match`, `invalid_pattern`.

#### `set_equality`

The candidate string is split into elements by `parse`:

- `json_array` - parse the candidate as JSON, which must be an array (`parse_error` otherwise)
- `lines` - normalise line endings, split on `\n`
- `delimiter` - split on the literal `delimiter`

then each element is normalised to the verifier's `normalization` form (§6.0, default `NFC`), and
`trim_elements` (default `true`) and `drop_empty` (default `true`) are applied. The expected
elements go through the same normalisation. `element_comparator` is one of `exact_string`,
`case_insensitive_string`, `numeric` (parsed by the `numeric_tolerance` grammar, with
`numeric_abs_tol` / `numeric_rel_tol`), or `json` (structural deep equality, over strings and keys
that have themselves been normalised).

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

Shape only; it never looks at meaning. The candidate is normalised to the `normalization` form
(§6.0, default `NFC`) **first**, then optional `normalize_line_endings` (default `true`) and
`trim` (default `false`) are applied, and then the checks run in this fixed order, the **first**
failure being the reported code:

1. `min_length` / `max_length`, in the `length_unit` of §6.0 (default `codepoints`) →
   `length_out_of_bounds`
2. `min_lines` / `max_lines`, by the §6.0 line count → `line_count_out_of_bounds`
3. `required_substrings`, in declaration order → `missing_required_substring`
4. `forbidden_substrings`, in declaration order → `forbidden_substring_present`

Normalisation runs before the length is taken, and the order is normative because it changes the
answer: `cafe\u0301` is six code points and NFC makes it five. Each substring is normalised to the
same form before it is looked for, so a needle and a haystack written in different composition
forms still match.

`case_sensitive` (default `true`) applies to the substring checks only, and lowercases with the
locale-independent default Unicode mapping — never a locale-sensitive one, because Turkish `İ`
lowercases to `i̇` under the root locale and to `i` under `tr`, and a verifier's answer must not
depend on the machine it runs on. Every field is optional; a verifier with no fields set passes
everything, which is a legitimate way to say "any output is structurally acceptable".

Codes: `ok`, `length_out_of_bounds`, `line_count_out_of_bounds`,
`missing_required_substring`, `forbidden_substring_present`.

### 6.2 The verifier field may hold a list

A verifier field — a template's `verifier`, an instance's `verifier`, a conformance row's
`verifier` — holds **either one verifier object or an array of declarative verifiers**. An array
means every element must pass. An empty array passes, which is the identity element and a
legitimate way to say "no constraint".

**Every element runs. There is no short circuit.** The overall `code` is the first failing
element's, verbatim, so ordering the elements chooses which diagnosis leads; but the verdict also
carries `detail.elements`, one entry per element in list order:

```json
{ "index": 1, "type": "regex", "passed": false, "code": "invalid_pattern" }
```

Unlike the rest of `detail`, **`detail.elements` is normative** and the conformance suite compares
it entry for entry. Two implementations that reach the same overall verdict by running different
elements have diverged, and a per-element report the two disagree about is worse than none.

Running everything is what makes the report worth having, and it also closes a hole. Under the
combinator this replaces, `[exact, regex-with-an-unusable-pattern]` returned the `exact` mismatch
and never looked at the pattern, so a template that could not be scored was indistinguishable
from an answer that was merely wrong. Now the verdict leads with `mismatch` and its element report
names `invalid_pattern` on element 1.

**Elements must be declarative, and that is a structural rule rather than a runtime one.** The
array references `#/$defs/verifier_declarative`, and a template's array references
`#/$defs/verifier_binding_declarative`, whose type enum omits the executable tier. A document with
an executable element therefore fails schema validation, in any validator, before a dispatcher is
reached. Implementations refuse it again at dispatch, because dispatch is reachable without a
schema check, and the conformance corpus asserts both halves separately.

The asymmetry is deliberate: the single-object form admits an executable verifier and the array
form does not. A single verifier that a given implementation cannot run is a task that
implementation cannot score, and it says so. An executable element hidden among declarative ones
is a way to obtain a verdict from partially checked output, which is the failure this document
exists to prevent.

**Arrays do not nest.** Elements are objects, so an array cannot contain an array. There is no
depth limit because there is no depth. An array that contains one is refused structurally and
again at dispatch.

Order matters and is the point: put the check whose failure is most diagnostic first. A template
that wants both "the extracted values are right" and "the serialisation is right" should write
`json_schema` before `exact`, so that a wrong answer leads with a schema violation rather than a
string mismatch — and the element report still distinguishes the two failures from each other.

A one-element array and a bare verifier are different documents and stay distinguishable in the
verdict: the array reports `elements`, the bare verifier does not.

### 6.3 Executable tier

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

- Object keys sorted by Unicode **code point**, ascending. Not by UTF-16 code unit: JavaScript's
  default `Array.prototype.sort` orders `"\u{1F44D}"` before `"\uFFFF"` and a conforming
  implementation must not. Python's `sorted` is already correct here.
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
- **Restriction:** a document must not contain an integer outside the safe double range,
  `±(2^53 - 1)`, because a JavaScript reader would silently see a different number and therefore
  compute a different hash.

  The restriction is on documents, and it is enforced where the distinction still exists. Python
  has arbitrary-precision integers, so it rejects such a value on the way in. A JavaScript
  implementation cannot: by the time `JSON.parse` returns, `9007199254740993` has already become
  `9007199254740992` and no serialiser can tell. What a JavaScript implementation must *not* do is
  reject large numbers at serialisation time as a substitute, because a value like `1e21` is a
  perfectly legal JSON number that Python reads as a float and writes back as `1e+21`; refusing it
  would turn a safety check into the divergence it was meant to prevent.

Content hash: `sha256:` followed by the lowercase hex SHA-256 of the UTF-8 canonical JSON of the
merged template document.

## 10. Conformance

`spec/conformance/` holds one JSON file per declarative verifier type, plus
`verifier_list.json` for the list-valued shape of the verifier field, each a
`#/$defs/conformance_file`. Every case is `{ id, verifier, candidate, expected }` where
`expected` is `{ passed, code }`, plus `elements` when the verifier is a list — required in that
case and forbidden otherwise.

A file may also carry two kinds of negative row. `rejections` assert that a configuration is
refused at dispatch rather than evaluated: strict dispatch raises, lenient dispatch returns a
failing verdict, and neither may be a pass. `schema_rejections` assert that a document is refused
by schema validation before any verifier runs, and each carries a near-identical
`valid_counterpart` the schema must accept, so the row cannot pass because the schema rejects
everything. The two are different guarantees — the first depends on reaching this project's
dispatcher, the second holds for any validator — and they are asserted separately.

Both implementations run the same files. The suite deliberately includes empty strings, floating
point edge cases, NaN and infinities, deeply nested JSON, regex metacharacters, and mixed line
endings, because those are exactly the places two engines drift apart.

Every declarative verifier's case set is additionally required to contain, at minimum, **one
astral character, one combining sequence, one ZWJ sequence and one mixed-script string**, and a
test enforces the requirement rather than trusting an author to remember. The rule exists because
its absence hid a real defect: a corpus of Devanagari and Hangul is entirely within the Basic
Multilingual Plane, so every case agreed on both sides while the subset's end-of-input construct
diverged on the first astral character anyone would have tried. A corpus that cannot reach a
divergence is not evidence that there is none.

Any divergence fails CI.

`conformance/seed-fixture.json` pins the seed derivation, and `conformance/canonical-json.json`
pins canonical JSON serialisation. Both are executed by both suites.

## 11. Versioning

The spec version identifier changes only on a breaking change to document shapes or to verifier
semantics. A new verifier type, a new optional field, or a new verdict code is additive and does
not change it, but it does require a conformance file before it may be used.

### 11.1 What changed in v2

One breaking change, plus the rename that follows from it.

- **`all_of` is gone.** Composition moved from a verifier type to a shape of the verifier field
  (§6.2). A `v1` template whose `verifier` was `{"type": "all_of", "verifiers": [...]}` becomes a
  `v2` template whose `verifier` is that array. Nothing else in the migration changes, and no
  template in this repository used nesting.
- **A list verdict now carries a normative per-element report.** `all_of` returned the first
  failure and said nothing about the rest; a list runs every element and reports each one.
  Overall `passed` and `code` are unchanged for any configuration `all_of` could express, so the
  scores of an existing set do not move — what changes is that a second failure is now visible,
  and that an element whose configuration is unusable is reported instead of being skipped when
  an earlier element already failed.
- **Three constructs that existed only to support `all_of` are gone with it**: the nesting depth
  limit, the eager pre-walk that had to visit every descendant before evaluating anything, and
  the runtime executable-child rejection as the primary defence. Executable elements are now a
  schema violation. Each removed construct was a place two implementations could disagree, and
  the previous pass showed that some such disagreements are invisible to parity testing.

Three additive changes were made after the list-valued verifier field and before `v2` was
tagged. They are recorded here rather than as a version bump because no `v2` document was
published in the interim, so nothing exists that they could break.

- **`translation_status` is required on every locale layer** (§1.2), so that a placeholder
  locale cannot be mistaken for a translated one by anything downstream.
- **`code_mix_ratio` is required on every instance and is always `null`** (§1.3).
- **The `locale` pattern admits a script subtag**, so Hinglish is expressible as `hi-Latn`.
  Hindi in Latin script tokenises quite differently from Hindi in Devanagari, and treating the
  two as one locale would average the difference away.

`v1` documents are not accepted by a `v2` implementation: the `spec_version` field is a `const`
in the schema and the reader checks it, so a stale set fails loudly rather than being scored
under semantics it was not written for.

## 12. Licence

Apache-2.0, same as the repository. The spec text may be reimplemented freely; a reimplementation
that passes `spec/conformance/` may describe itself as conforming to Redrob Verifiable Task
Spec v2.
