# Blockers

Decisions taken during unattended work that could not be resolved from the task prompt, each with
the options considered, the provisional choice, and why. A provisional choice is not a
recommendation; it is what let the work continue. Every one of these is cheap to reverse now and
expensive to reverse after something depends on it.

---

## 1. Where the TypeScript implementation lives

**Decision.** The prompt says "under `src/generate/`". There is no `src/` directory at the
repository root; the monorepo is `apps/web` plus `packages/*`, and each package has its own `src/`.

**Options.** (a) Create a root `src/`, matching the prompt literally but inventing a fourth
top-level source location. (b) `packages/harness/src/generate/`, alongside the optimizer, metrics
and providers the workbench already shares. (c) A new `packages/generate-ts` workspace.

**Chose (b),** `packages/harness/src/generate/`. The harness is where shared non-UI logic already
lives, so a reader looking for evaluation code finds it there. A root `src/` next to `apps/` and
`packages/` would be a fourth convention in a repo that has three.

It is exported as a **subpath**, `@redrob/harness/generate`, not from the harness index. The module
imports `node:child_process` and `node:fs/promises`, and the harness index is imported by the web
app; adding these to it would drag Node built-ins into the Next.js client graph for no benefit.
Nothing imports the subpath yet.

**Reverse by** moving the directory and updating the `exports` map plus five test imports.

---

## 2. There was no test runner to add a TypeScript conformance test to

**Decision.** The prompt says to add the conformance test "in the existing test setup". There isn't
one: the repo has `yarn verify:*` scripts, each a `tsx` script that throws on failure, and no
`yarn test`.

**Options.** (a) Write the conformance suite as another `verify:*` script. (b) Add a real test
runner as a dev dependency (vitest, jest). (c) Node's built-in test runner, run through the `tsx`
loader the repo already has.

**Chose (c).** 289 conformance cases need per-case reporting, which a script that throws on the
first failure does not give; and a new test framework is a dependency plus a config file for
something Node 22 already ships. `yarn test` runs `node --import tsx --test scripts/test/*.test.mts`.
Tests sit in `scripts/` so the root `tsconfig.json` already typechecks them.

**Note:** `.github/workflows/ci.yml` was **not** modified — the new suite runs in
`.github/workflows/conformance.yml` as the prompt specifies. If `yarn test` should also gate the
main pipeline, add one line to `ci.yml`.

---

## 3. An eighth declarative verifier, `all_of`

**Decision.** The prompt fixes the declarative tier at seven types, and separately asks for an
extraction template "verified by `json_schema` plus `exact`". A template carries exactly one
verifier, so the two requirements cannot both hold without composition.

**Options.** (a) Encode the exactness inside the JSON Schema with `const` on every property, using
only the seven types. (b) Add a composite `all_of` verifier. (c) Drop the `exact` half and verify
only the schema.

**Chose (b).** (a) does not actually express the requirement: `const` pins the *values* but says
nothing about the *serialisation*, and the template's contract is minified JSON with sorted keys,
which is a string property no schema can state. (c) drops a stated requirement.

`all_of` runs its members in order and reports the first failure's code, so a wrong extraction
reports `schema_violation` naming the offending field rather than a bare string mismatch. It is
declarative, executes identically in both languages, nests to depth 8, and forbids executable
members. It has its own conformance file with 20 cases.

**This is an addition to the spec surface the prompt described.** If it is unwanted, deleting it
means reworking the extraction template's contract, not just removing a file.

### 3a. Assessment: should `all_of` remain a verifier type at all?

Requested during the pre-merge pass. Not changed in this task; recorded for a human decision.

**The alternative.** A template's `verifier` field becomes a *list* of verifiers rather than one
verifier, run in order, first failure wins. That is the same behaviour `all_of` provides, and it
costs nothing in spec surface: no new type, no composition semantics, no nesting depth, no
recursive walk, and no separate conformance file.

**What the alternative removes, concretely.** Ten items: the `verifier_all_of` definition, the
`verifier_declarative` definition that exists only to constrain its children, the eager
declarative-tree walk in both implementations, the depth limit and its off-by-one, the recursion in
both `verifyAllOf` and `_run_all_of`, the 22 `all_of` conformance cases, the 14 rejection rows added
in this pass, the `conformance_rejection` schema definition those rows needed, and the argument in
§6.1 explaining why the walk must be eager. Most of the risk this pass was spent removing exists
only because composition is a value rather than a field.

**What the alternative loses.** Nesting, which no template uses and which I cannot construct a
motivating example for. A list is flat; `all_of` inside `all_of` groups checks, but since the
semantics are "first failure wins" across the whole tree, grouping changes nothing observable. The
nesting is expressive power with no expressible difference, which is the worst kind.

**It also loses a real thing:** `all_of` is a *value*, so it can appear anywhere a verifier can —
today only at a template's root, but a future `any_of`, or a per-field verifier inside a structured
comparison, would want composition to nest. A list at the root cannot be reused that way. Whether
that matters depends on whether the tier is ever extended, and nothing in the current design says
it will be.

**Assessment.** The list is the better design on the evidence available. `all_of` was reached for
because "a template has one verifier" felt like a fixed constraint, and it was not — it is one line
of the schema. The cost of keeping `all_of` is not that it is wrong, it is that it introduces
recursion, a depth limit and a tree walk into the one part of the system that must be provably
identical across two languages, in exchange for expressive power no template uses.

**Recommendation, for a human to accept or reject:** replace `all_of` with a list-valued `verifier`
field before the spec is cited anywhere. After that the change is a v2, and the whole point of the
draft notice in §0 is that this window is open now and closes at the preprint. If the tier is
expected to grow an `any_of` or a `not`, keep `all_of` instead and accept the machinery, because
adding composition back after removing it is worse than never removing it.

Not changed in this pass because it touches the schema, both implementations, the extraction
template's contract and 36 conformance rows, and doing that unattended on the strength of my own
assessment is exactly the kind of decision this record exists to defer.

---

## 4. JSON Schema: a documented subset, not a library

**Decision.** `json_schema` must behave identically in both languages. Python has `jsonschema`;
TypeScript has no validator in the dependency tree.

**Options.** (a) Add `ajv` as a TypeScript runtime dependency. (b) Implement a documented keyword
subset in both languages. (c) Route all `json_schema` verification through the Python bridge.

**Chose (b).** (a) is a runtime dependency the prompt asks to justify, and it would not even buy
agreement: `ajv` and `jsonschema` are two implementations of a large specification and they differ
at the edges, so the divergence risk would move rather than disappear. (c) would make the most
common verifier type unusable without Python, contradicting "Python is optional".

Both sides validate the schema document against the same keyword allow-list before use, so a schema
one side cannot evaluate fails loudly on both rather than passing on one. Supported: `type`,
`enum`, `const`, `properties`, `required`, `additionalProperties`, `patternProperties`,
`propertyNames`, `dependentRequired`, `minProperties`, `maxProperties`, `items`, `prefixItems`,
`contains`, `minContains`, `maxContains`, `minItems`, `maxItems`, `uniqueItems`, `minimum`,
`maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `minLength`, `maxLength`,
`pattern`, `allOf`, `anyOf`, `oneOf`, `not`, `$ref` (local `#/$defs/` only), `$defs`, `$schema`,
`$comment`, plus the annotation keywords that assert nothing (`title`, `description`, `default`,
`examples`, `deprecated`, `readOnly`, `writeOnly`).

**Not supported, and rejected rather than ignored:** `format` (assertion behaviour is optional in
the specification, so it cannot be normative), `if`/`then`/`else`, `dependentSchemas`,
`dependencies`, `unevaluatedProperties`, `unevaluatedItems`, `contentEncoding`,
`contentMediaType`, `contentSchema`, `$id`, `$anchor`, `$dynamicAnchor`, `$dynamicRef`,
`$vocabulary`, and any non-local `$ref`. The last one also means a verifier can never resolve a
schema over the network.

**Consequence:** a template author who needs a keyword outside this list is stuck. Widening the
list requires implementing it twice and adding conformance cases, which is the intended cost.

### 4a. The subset is checked against `ajv`, as a dev dependency

Added during the pre-merge pass. The objection to (b) above was that a hand-written validator can
be subtly wrong, and the conformance suite cannot see it: parity only proves the two
implementations agree, and two implementations that share a misreading agree perfectly.

`ajv` is now a **dev** dependency and the corpus runs through it as a third opinion, in
`scripts/test/generate-json-schema-oracle.test.mts`. It is not imported by any shipped module, and
a test asserts both that no manifest lists it under `dependencies` and that no file under
`packages/harness/src/generate/` imports it.

The three-way argument, since no single test states it: the Python conformance suite proves
`jsonschema` matches each recorded expectation; the TypeScript conformance suite proves the
hand-written validator matches it; the oracle test proves `ajv` matches it too, and separately that
`ajv` and the hand-written validator agree case by case. Two independent libraries agreeing with
both implementations is what rules out a shared misreading.

**Result: no disagreements.** `DOCUMENTED_DISAGREEMENTS` is empty in both files, and an entry in
it is a claim that a hand-written validator reads the specification better than a library with a
decade of use, so each one would need its reasoning written out rather than an id.

The oracle was checked against a deliberate fault before being trusted: disabling the
`uniqueItems` branch in the TypeScript validator turns three oracle rows red, so the test does
detect a real divergence rather than passing vacuously.

The Python side has no hand-written validator to test — `verify_json_schema` gates the schema and
then calls `jsonschema` — so `packages/generate/tests/test_json_schema_oracle.py` proves the two
things that *can* be wrong there: that the hand-written subset gate never changes the library's
verdict, and that the library matches the recorded expectation, which is the pivot the TypeScript
oracle test relies on. The file says so rather than implying more.

---

## 5. Regex: the subset holds nothing engine-dependent, and there is no translator

**Superseded during the pre-merge pass.** The original decision is kept below because the
reasoning that produced it is the reasoning that had to be undone, and a record that only shows
the final answer is not a record.

### What was decided first, and why it was wrong

`re` and `RegExp` disagree about `.`, `$`, `\d`, `\w`, `\s` and `\b`. The first decision made
Python's `re.ASCII` semantics normative and had the TypeScript side rewrite each pattern before
compiling: `.` to `[^\n]`, `\s` to an explicit ASCII set, `^` and `$` to lookarounds reproducing
Python's multiline behaviour, and never the `u` flag so that `\d` and `\w` stayed ASCII.

It was wrong for a reason that has nothing to do with regex. **Pinning ASCII semantics means
Devanagari contains no word characters, `०१२` are not digits, and a Hangul string has no word
boundary anywhere in it.** For a benchmark whose targets are Hindi, Hinglish and Korean, `\w` was
not a portability compromise — it was a wrong answer that looked like a working pattern, and
looked like one on both implementations, so the conformance suite agreed with itself all the way
down. Two implementations that agree on the wrong answer is exactly the failure the suite cannot
detect on its own.

The second problem was the translator itself. A layer that rewrites one regex dialect into another
is a second implementation of regex semantics, and it needed a conformance suite of its own to be
trustworthy. It did not have one.

### What is decided now

The subset contains no construct whose meaning depends on which engine reads it, and both
implementations compile the pattern verbatim.

- **`\w \W \d \D \b \B \s \S` are rejected**, at verify time with `invalid_pattern` and at
  template load time with an error naming the construct. Write the class out: `[0-9]`,
  `[A-Za-z0-9_]`, `[\u0900-\u097F]`.
- **`.` is rejected.** Python excludes only `\n`; JavaScript also excludes `\r`, U+2028 and
  U+2029. Write `[^\n]`, or `[\u0000-\uffff]` for any character at all.
- **`$` is rejected.** Python's `$` also matches before one trailing newline. Use
  `mode: full_match` to anchor, or, where mode is unavailable, the lookahead
  `(?![\u0000-\uffff])`, which both engines read identically.
- **`^` stays.** Without `m` it is start of input in both engines.
- **The flag subset is `i` alone, and only on an ASCII-only pattern.** `m` and `s` are gone
  because there is no `$` or `.` left for them to modify. `i` is confined because a JavaScript
  `RegExp` without `u` folds Greek and Cyrillic but will not fold a non-ASCII character down to an
  ASCII one, while Python under `re.ASCII` folds nothing outside ASCII; restricted to an ASCII
  pattern the two coincide exactly. Devanagari and Hangul are caseless, so nothing is lost here.
- **`re.ASCII` is still passed on the Python side,** and now has exactly one job: confining
  `IGNORECASE` to ASCII folding.

**Deviation from the pre-merge instruction, stated plainly.** That instruction named only the
shorthand classes and asked for the rewriting layer to be removed. Banning `.` and `$` was not
requested. It is nonetheless entailed: with `.` and `$` still in the subset the translator cannot
be removed without introducing the divergence it existed to hide, so the choice was between
removing them and keeping a rewriting layer for two constructs. Removing them is the option
consistent with the reason the shorthand classes were banned.

**What it costs.** `^...$` inside a JSON Schema `pattern` is the idiom everyone writes, and it is
now spelled `^...(?![\u0000-\uffff])`. That is uglier. It is also unambiguous, which `$` was not.

**One divergence remains, documented in the spec and excluded from the suite:** a quantified class
spanning astral characters, which a UTF-16 engine counts as two units and Python as one. Patterns
are documented as BMP-only, and Devanagari and Hangul are in the BMP.

**The case-folding divergence recorded in the original decision is now closed** rather than
documented, by confining `i` to ASCII patterns.

---

## 6. Template derivations are a Python-only expression language

**Decision.** Expected answers must be computed at generation time. A `2x + 5 = 11` template needs
arithmetic; the extraction template needs to build a document and its ground truth together.

**Options.** (a) Templates name a Python solver function. (b) Templates carry expressions in a
restricted language, evaluated by an AST walker with a node allow-list. (c) Precompute answers and
store them in the template, which defeats parametric generation.

**Chose (b).** (a) makes a template a pointer into a codebase rather than a self-contained
document, so it cannot be published and reused. The evaluator allows arithmetic, comparisons,
conditionals, f-strings, comprehensions and a fixed function list; it allows no attribute access,
no imports, no calls to anything unlisted.

**Consequence:** template *generation* is Python-only, so a TypeScript-only user can read, audit
and verify a published set but cannot produce one. This matches the prompt's split of
responsibilities, but it is a real asymmetry and the phrase "neither implementation is
authoritative" is about the *spec*, not about capability.

---

## 7. Canonical JSON numbers, and where the safe-integer rule is enforced

**Decision.** Content hashes must match across languages, so number formatting must match exactly.
Python's `repr` writes `1e-09` where JavaScript writes `1e-9`, and switches to exponent notation at
`1e16` where JavaScript waits until `1e21`.

**Options.** (a) Ban values whose formatting differs — which bans `1e-9`, a perfectly ordinary
tolerance. (b) Reimplement the ECMAScript `Number::toString` presentation rules in Python.

**Chose (b).** The shortest round-trip *digits* already agree between the two runtimes; only the
presentation differs, so only the presentation is reimplemented.

A related trap was caught by the conformance fixture rather than by review: an early TypeScript
version rejected integers above 2^53 at serialisation time as a safety check, which refused `1e21`
— a legal JSON number Python reads as a float and writes back as `1e+21`. The restriction is on
**documents**, and it is enforced where the distinction survives: Python rejects an oversized
integer on the way in, JavaScript cannot, because `JSON.parse` has already rounded it. Documented
in spec §9.1.

Object keys sort by **code point**. JavaScript's default sort compares UTF-16 code units and orders
`"\u{1F44D}"` before `"\uFFFF"`, which is wrong here; a conforming implementation supplies a
comparator. Also caught by the fixture.

---

## 8. Zenodo DOI is `TBD`

**Decision.** The prompt specifies a placeholder DOI of `TBD`.

**Where it appears.** Every generated manifest's `citation.doi`, and the `--doi` default in
`redrob-generate emit`.

**Where it deliberately does not.** `CITATION.cff` has no `doi:` key. The CFF schema requires a
real `10.x` value there, and a placeholder that resolves to nothing is worse than an honest
absence, so the file carries an `identifiers` entry marked `TBD` instead.

**A DOI must be minted at first release.** Until then any dataset shared from this repository is
uncitable in the sense that matters: a reader cannot resolve the identifier to a fixed artifact.

---

## 9. Executable verifiers run model-derived text, and are not sandboxed

**Decision.** `python_unittest` executes test code against model output, and `sympy_equiv` parses a
model-supplied expression with SymPy. Sandboxing was not in scope for this task.

**What was done instead.** `sympy_equiv` parses with `sympy.parsing.sympy_parser` under a
restricted local dictionary, not `eval`. `python_unittest` runs in a subprocess with a timeout.
`redrob-generate verify --no-executable` refuses both, and the TypeScript side cannot run them at
all.

**Not done.** No seccomp, no container, no filesystem or network isolation for the subprocess. A
malicious *template* — not a malicious model output — could run arbitrary code through
`python_unittest`. Templates are code and should be reviewed as code; that is a policy, not a
control. **Anyone running untrusted templates needs a real sandbox first.**

---

## 10. Set layout, and the clock

**Decision.** The prompt says `emit` "writes instances plus manifest" without fixing the format,
and requires byte-identical reruns with the timestamp excluded.

**Chose** `instances.jsonl` (one canonical-JSON instance per line) plus `manifest.json`. JSONL
streams, diffs per instance, and appends; a single JSON array does none of those.

For the clock: `--created-at` and `--citation-year` are arguments rather than reads of the system
clock, so a rerun is byte-identical including the manifest, with nothing to exclude. `SOURCE_DATE_EPOCH`
was considered and not used — it is a build-system convention, and an explicit flag is
discoverable in `--help`.

---

## 11. A generated set is checked into the repository

**Decision.** `spec/conformance/example-set/` holds three instances emitted by the Python side, so
that the TypeScript tests can audit real Python output — recomputing seeds and the template content
hash — rather than round-tripping their own.

**Cost.** A generated artifact in version control goes stale when a template changes. Mitigated the
way `exports/samples` already is: a CI job regenerates it and fails on any diff.

---

## 12. The math template uses `numeric_tolerance`, not `sympy_equiv`

**Decision.** The prompt allows either for the math family.

**Chose `numeric_tolerance`,** so the one worked example in the documentation runs in both
implementations and needs no Python to verify. `sympy_equiv` is implemented and tested, but a
template that used it would be Python-only, which is a poor first example of a module whose central
claim is that two implementations agree. A symbolic variant is a one-line verifier swap.

---

## 13. No non-English templates exist

**Decision.** The prompt forbids writing template content in any language other than English, and
asks for the structure that will hold translations.

**State.** The structure exists: `templates/<family>/<name>/template.json` carries the
locale-neutral core, `locales/en.json` carries the wording, and a sibling `locales/xx.json` is all a
translation needs. A locale layer may set only `locale`, `description`, `prompt` and `notes`;
redeclaring parameters, derivations or the verifier fails to load, which is what guarantees that two
locales of one template sample identical values from identical seeds and expect identical answers.
That guarantee is also what makes their token counts comparable, per the fertility hook.

**No translation has had native-speaker review, so none exists.** Stated in `templates/README.md`.

---

## 14. One line added to the root `tsconfig.json`

**Decision.** The definition of done requires `tsc --noEmit` to be clean. On a clean checkout of
`main` it is not: six `TS5097` errors, all of the form "an import path can only end with a '.ts'
extension when `allowImportingTsExtensions` is enabled", in `scripts/datasets/fetch.mts`,
`scripts/verify-selfhosted.mts` and `scripts/verify-tournament.mts`. None of them come from this
work — `yarn typecheck`, which runs the harness and tokenizers projects, never covered
`scripts/`, so the errors were invisible.

**Options.** (a) Rewrite the import specifiers in three existing scripts. (b) Enable
`allowImportingTsExtensions` in the root `tsconfig.json`. (c) Leave it, and report the item as
failing for a pre-existing reason.

**Chose (b),** one line. It changes no runtime behaviour — `tsx` already resolves those imports,
which is why the scripts run — and the flag is only permitted when the project never emits, which
this one does not. (a) touches three files belonging to Compare and Deploy for a cosmetic reason,
which the prohibitions discourage.

---

## 15. Fertility: interface only, and no default tokenizer

**Decision.** The prompt asks for the hook and forbids selecting or bundling a tokenizer.

**State.** `packages/generate/src/redrob_generate/fertility.py` defines a `Tokenizer` protocol
(`name`, `version`, `count_tokens`), a per-instance record, and a manifest rollup. Tested with a
stub. Nothing calls it during `emit` unless a caller passes a tokenizer, and the manifest omits the
`fertility` block entirely when none was supplied.

**Open:** the CLI has no `--tokenizer` flag, because loading one would mean choosing one. A caller
uses the Python API. If measurement should be available from the command line, the flag needs to
name an importable object rather than a model id, or the "no tokenizer dependency" rule breaks.
