# Generate: parametric verifiable evaluation tasks

> **Squash merge this branch.** The commit history contains `logs/`, a directory of build and
> test transcripts that the final commit removes from the tree and `.gitignore` keeps out. Those
> blobs stay reachable through this branch's history, and a squash merge is what keeps them out
> of `main`'s. Nothing sensitive is in them — the leakage scan is the first section of the
> second report below, findings and all — but build output does not belong in a repository's
> permanent history regardless.
>
> **On which logs are worth keeping.** Published *evaluation* run logs are core to this
> project. They are the evidence behind a published score, they are not reproducible by
> re-running anything, and they belong versioned alongside a manifest that says what produced
> them. Build and test output from a development task is a different category: it is the
> transcript of a machine doing something deterministic, it is regenerable by
> `bash scripts/verify-generate-dod.sh`, and committing it buys nothing that a CI artifact does
> not. Conflating the two would either bloat history or, worse, make deleting run logs feel
> normal. CI now uploads build and test output as workflow artifacts with 30-day retention, so
> future runs stay inspectable without anything being committed.

---

## What this adds

A fourth module alongside Compare, Evolve and Deploy. An evaluation set drawn from a fixed list
stops measuring anything once the list is in a training corpus; this generates items fresh from a
seed and scores them with deterministic verifiers, so there is nothing to memorise and no judge
model whose opinions the score inherits.

Nothing in it has a user interface, calls a model API, or generates non-English content. Python
stays optional: the workbench installs, type-checks and builds on a machine with no interpreter,
and CI has a job that proves it by removing every `python` and `pip` entry from `PATH` first.

The spec is **draft** and carries a notice saying so. Pin a commit rather than tracking the
branch.

---

## Report 1 — foundation

*Originally `logs/SUMMARY.md`, reproduced in full. Both reports refer to sibling `.log` files
in `logs/`; that directory is not in the tree, and `bash scripts/verify-generate-dod.sh`
regenerates every one of them. CI uploads the same files as workflow artifacts.*

### Generate module foundation — final report

Branch `feat/generate-foundation`. `main` untouched. No force push, no rewritten history, no
deleted files.

Every command below was run in this workspace; full stdout and stderr for each are in the
sibling `.log` files, and `bash scripts/verify-generate-dod.sh` regenerates all of them.

---

## What was built

**The spec.** `spec/verifiable-task-v1.md` (the prose) and `spec/verifiable-task-v1.schema.json`
(the machine-readable one). Language-neutral: it defines Template, Instance, Verifier and Manifest,
the seed derivation, the sampling PRNG, the prompt rendering rules, canonical JSON, and the exact
verdict code each verifier must return in each situation. Python and TypeScript are both
implementations of it and neither is authoritative; `spec/conformance/` decides when they disagree.

**Seed derivation.** `seed = uint64_be(SHA256(generator_version || "\x00" || template_id || "\x00"
|| instance_index)[0:8])`, implemented in both languages and pinned by a 12-case fixture that
records the exact message bytes, the SHA-256 digest and the resulting seed, so a third
implementation can be checked against it without reading either of these two. The spec states the
reason plainly: a conventional seed such as `42` is unverifiable, because a reader cannot
distinguish one run from the best of several, whereas a content-derived seed can be recomputed by
anyone from published values, which makes cherry-picking structurally impossible rather than
discouraged.

**The Python package,** `packages/generate/`, installable as `redrob-generate`, Apache-2.0,
Python 3.11+. `spec.py` (load, merge locale, validate, hash), `seed.py`, `prng.py` (SplitMix64, so
sampling does not depend on a language's stdlib RNG), `sample.py`, `expr.py` (the restricted
expression language template derivations are written in), `render.py`, `verify/` (declarative,
executable, and the shared regex and JSON Schema subset validators), `canonical.py`, `manifest.py`,
`fertility.py`, `cli.py`. Two commands, `emit` and `verify`, and the CLI is the only bridge
boundary: no HTTP service, no other IPC.

**The TypeScript side,** `packages/harness/src/generate/`, exported as the subpath
`@redrob/harness/generate` and imported by nothing yet. It reads generated sets, audits their seeds
and template content hashes, runs all eight declarative verifiers natively, raises an explicit
`UnsupportedVerifierError` for the executable tier, and talks to Python through a subprocess client
that reports absence with an actionable message. Its types are generated from the JSON schema by
`scripts/generate-spec-types.mts` rather than written by hand, with a drift check in the suite.

**The conformance suite,** `spec/conformance/`: 289 cases across the eight declarative verifier
types (exact 27, numeric_tolerance 37, json_schema 58, regex 51, set_equality 34, ordered_equality
26, format_constraint 36, all_of 20), plus a 12-case seed fixture, a 34-case canonical JSON
fixture, and a three-instance generated set for the reader to audit. Both implementations run the
same files. Cases deliberately include empty strings, Devanagari and Hangul, NFC/NFD and
precomposed/jamo pairs, floating-point boundaries, NaN and both infinities, deeply nested JSON,
regex metacharacters, and mixed line endings.

**Three English templates,** one per family: `templates/math/linear-equation` (numeric_tolerance),
`templates/extraction/quarterly-ledger` (a synthetic ledger with a planted row, verified by
`json_schema` and `exact` composed with `all_of`), and `templates/format/release-note`
(format_constraint). The locale split is real — core plus `locales/en.json`, and a locale layer may
change only the wording — but no non-English layer exists, and `templates/README.md` says why one
cannot simply be added.

**The fertility hook,** `fertility.py`: a `Tokenizer` protocol, a per-instance record, a manifest
rollup, tested with a stub. No tokenizer is bundled, chosen, or added as a dependency. The reason
it is worth a hook is in the module docstring: because generated items carry identical semantic
content across locales by construction, their token counts are directly comparable in a way
corpus-level fertility statistics are not, since those conflate the tokenizer with whatever the
corpus happens to talk about.

**Citation scaffolding.** `CITATION.cff` at the root, a BibTeX entry inside every manifest so the
citation travels with any shared dataset, and a one-line citation notice printed by `emit`.

**CI.** `.github/workflows/conformance.yml` with five jobs: the TypeScript suite, the Python suite
on 3.11 and 3.12, a diff of the two implementations' actual verdicts, a reproducible-emit check,
and a build with Python removed from `PATH`. `ci.yml` was not modified.

---

## Definition of done

| Item | Result | Log |
| --- | --- | --- |
| `yarn install && yarn build` with no Python installed | pass | `01-build-without-python.log` |
| `tsc --noEmit` clean | pass | `02-typecheck.log` |
| `yarn typecheck` (harness + tokenizers) | pass | `03-workspace-typecheck.log` |
| `yarn test`, including the TypeScript conformance test | pass, 327/327 | `04-yarn-test.log` |
| `pip install -e packages/generate` | pass | `05-pip-install.log` |
| `pytest packages/generate` | pass, 404 passed | `06-pytest.log` |
| `emit` twice, byte-identical including the manifest | pass, 3 templates | `07-reproducible-emit.log` |
| Checked-in example set matches a fresh emit | pass | `08-example-set-current.log` |
| Generated types match the schema | pass | `09-spec-types-drift.log` |
| Both suites agree on the identical case files, zero divergence | pass, 289 cases | `10-zero-divergence.log` |
| Compare / Evolve / Deploy unaffected | pass | `11-existing-verifiers-unaffected.log` |

### `yarn install && yarn build` on a machine with no Python

The check builds the shim `PATH` itself rather than trusting the runner: it symlinks every
executable on `PATH` into a temporary directory, skipping `python`, `python2`, `python3`,
`python3.*`, `pip`, `pip3` and `pip3.*`, then refuses to continue if `python3` is still reachable.

```
$ build_without_python

python:  not found
python3: not found
pip:     not found

yarn install v1.22.22
...
├ ƒ /api/status
├ ○ /compare
├ ○ /deploy
├ ○ /evolve
├ ○ /icon.svg
└ ○ /settings

Done in 9.52s.
```

### `tsc --noEmit`

```
$ npx tsc --noEmit -p tsconfig.json
(no output, exit 0)
```

This required a one-line change to the root `tsconfig.json`; see deviation 3 below.

```
$ yarn typecheck
$ tsc -p tsconfig.json --noEmit
$ tsc -p tsconfig.json --noEmit
Done in 2.24s.
```

### `yarn test`

```
1..327
# tests 327
# suites 0
# pass 327
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 491.551881
```

Including, by name:

```
ok 304 - seed fixture: identical seeds across implementations
ok 307 - running every conformance case opens no socket
ok 308 - reading, hashing and auditing a generated set opens no socket
ok 311 - every seed in the example set recomputes
ok 312 - a tampered seed is caught
ok 320 - runVerifier throws UnsupportedVerifierError for sympy_equiv
ok 323 - runVerifier throws UnsupportedVerifierError for python_unittest
ok 326 - an unknown verifier type is also an error, not a pass
```

### `pip install -e packages/generate && pytest packages/generate`

```
============================= 404 passed in 1.95s ==============================
```

Including:

```
test_conformance.py::test_seed_fixture PASSED
test_conformance.py::test_seed_fixture_covers_distinct_inputs PASSED
test_no_network.py::test_the_guard_itself_works PASSED
test_no_network.py::test_generation_opens_no_sockets[math/linear-equation] PASSED
test_no_network.py::test_generation_opens_no_sockets[extraction/quarterly-ledger] PASSED
test_no_network.py::test_generation_opens_no_sockets[format/release-note] PASSED
test_no_network.py::test_declarative_verification_opens_no_sockets PASSED
test_no_network.py::test_json_schema_validation_does_not_fetch_remote_schemas PASSED
```

### Both conformance suites pass on the identical case files, zero divergence

Each suite checking itself against the expected verdict already catches a divergence, but it
reports it as two separate red builds a reader has to correlate. So the check also dumps what each
implementation actually returned and diffs the two:

```
$ zero_divergence

TypeScript verdicts: 289 cases
Python verdicts:     289 cases

zero divergence
```

### `emit` twice produces byte-identical output including the manifest

`--created-at` and `--citation-year` are arguments rather than clock reads, so with them there is
nothing to exclude and the whole directory diffs clean:

```
--- linear-equation
    identical: 5e0c45030da1ee9e0acf0ca8c601a0bd8ff73536b51f859aa74d06256b2288cf  instances.jsonl
               f3e2bd256fdce68fb60a66a0a66f2ac089bccb837c09cca1f1a79e766d24392f  manifest.json
--- quarterly-ledger
    identical: ca6c8bf8dfb5d5755d678ada534a914b99373997dce468c0e8f329ef416694a3  instances.jsonl
               8ac0d169182f601b4c6663dceb8dec66d0bd58e5d26f98e9c15207a03adc9e35  manifest.json
--- release-note
    identical: d364ba1500e99b87c96f53f0739f5c88c12ca1fbc5a875f3def17de08fed5bc4  instances.jsonl
               c0e147ec0b348d2c1b7cd1e2562a8a9139ab9de99188718613be79fc326b3d55  manifest.json
--- default invocation, created_at excluded
    identical apart from created_at
```

The last line is the default invocation, where the clock *is* read, diffed with only `created_at`
removed — the form the definition of done asks for.

### Cross-language seed fixture

`spec/conformance/seed-fixture.json` carries, for each of 12 cases, the generator version, template
id, instance index, the message bytes as hex, the SHA-256 digest and the seed. Python asserts all
four (`test_seed_fixture`); TypeScript asserts all four (`seed fixture: identical seeds across
implementations`). Recomputable by hand:

```
$ python3 -c 'import hashlib; print(int.from_bytes(hashlib.sha256(b"0.1.0\x00math.linear_equation\x000").digest()[:8], "big"))'
10868130423516751893
```

which is the `seed` field of instance 0 in `spec/conformance/example-set/instances.jsonl`.

### TypeScript raises an explicit error on executable verifier types

Four assertions per executable type in `scripts/test/generate-unsupported.test.mts`:
`runVerifier` throws `UnsupportedVerifierError` carrying the offending type; `runVerifierOrFail`
returns `{ passed: false, code: 'unsupported_verifier' }`; the type is classified executable and
not declarative. An unknown type and a verifier with no `type` tag are covered the same way. There
is no configuration flag that turns any of them into a pass. The stakes are stated in the module
comments in `verdict.ts` and `registry.ts`: a skipped verifier reported as a success inflates every
score computed from the run and the inflation is invisible in the output.

### No network access during generation or declarative verification

Python (`test_no_network.py`) monkeypatches `socket.socket`, `socket.create_connection`,
`socket.getaddrinfo` and `socket.gethostbyname` to raise, then generates from all three templates
and runs every declarative conformance case. TypeScript (`generate-no-network.test.mts`) replaces
`fetch`, `net.connect`, `net.createConnection`, `net.Socket#connect`, `tls.connect`, `dns.lookup`,
`dns.promises.lookup`, `http.request` and `https.request` with tripwires, then does the same plus
reading, hashing and auditing a generated set. Both suites first assert that the tripwire itself
fires, so a test that passes because the patch silently failed to apply is not possible. Both also
assert that a schema with a remote `$ref` is refused at configuration time rather than fetched.

---

## Blockers

Full text in `BLOCKERS.md` at the repository root. Fifteen entries; the provisional choices:

1. **Where the TypeScript implementation lives.** The prompt says `src/generate/`; there is no root
   `src/`. Put it in `packages/harness/src/generate/` and exported it as the subpath
   `@redrob/harness/generate`, so its `node:child_process` import cannot reach the Next.js client
   graph.
2. **No test runner existed** to add "a TypeScript conformance test in the existing test setup" to.
   Used Node's built-in test runner through the `tsx` loader the repo already has, wired to a new
   `yarn test`. No new framework dependency.
3. **Added an eighth declarative verifier, `all_of`.** The prompt fixes the tier at seven types and
   separately requires a template verified by "`json_schema` plus `exact`"; a template carries one
   verifier, so the two cannot both hold without composition. This is the one place the spec
   surface is larger than the prompt described.
4. **JSON Schema is a documented keyword subset implemented twice,** not `ajv` plus `jsonschema`.
   Two libraries would move the divergence risk rather than remove it, and a runtime dependency
   would need justifying anyway. Unsupported keywords are rejected on both sides, not ignored.
5. **Regex: Python's `re.ASCII` semantics are normative** and TypeScript rewrites the pattern before
   compiling. Two divergences remain documented and out of the suite: full versus simple case
   folding under `i`, and astral characters under a quantified `.`.
6. **Template derivations are a Python-only restricted expression language,** so generation is
   Python-only while reading, auditing and verifying are not. A real asymmetry, stated as one.
7. **Canonical JSON reimplements ECMAScript `Number::toString` in Python** rather than banning
   values whose formatting differs, and the safe-integer rule is a restriction on *documents*
   enforced where the distinction survives. Object keys sort by code point, not UTF-16 code unit.
8. **DOI is `TBD`** in every manifest. `CITATION.cff` omits the `doi:` key rather than carrying a
   placeholder the schema would reject. A Zenodo DOI must be minted at first release.
9. **Executable verifiers are not sandboxed.** SymPy parses under a restricted local dictionary and
   `python_unittest` runs in a subprocess with a timeout, but there is no seccomp, container or
   filesystem isolation. A malicious *template* could run arbitrary code. Anyone running untrusted
   templates needs a real sandbox first.
10. **Set layout is `instances.jsonl` plus `manifest.json`,** and the clock is an argument
    (`--created-at`, `--citation-year`) rather than a read, which is what makes a rerun byte-identical
    with nothing excluded.
11. **A generated set is checked in** at `spec/conformance/example-set/`, so the TypeScript tests
    audit real Python output. Kept fresh by a CI job that regenerates it and fails on any diff, the
    same way `exports/samples` already works.
12. **The math template uses `numeric_tolerance`, not `sympy_equiv`,** so the documented worked
    example runs in both implementations. `sympy_equiv` is implemented and tested; a symbolic
    variant is a one-line verifier swap.
13. **No non-English templates exist.** The structure holds them; none has had native-speaker
    review, and `templates/README.md` sets out what such a review has to confirm.
14. **One line added to the root `tsconfig.json`** (`allowImportingTsExtensions`), because
    `tsc --noEmit` was already failing on a clean `main` with six `TS5097` errors in existing
    scripts. See deviation 3.
15. **Fertility is interface-only with no CLI flag,** because a `--tokenizer` flag would mean
    choosing a tokenizer, which the prompt forbids.

---

## Deviations from the prompt

**1. `packages/harness/src/generate/` instead of `src/generate/`.** There is no root `src/` in this
monorepo and creating one would have been a fourth top-level source convention. Blocker 1.

**2. An eighth declarative verifier type, `all_of`.** The prompt's list of seven and its requirement
for a template "verified by `json_schema` plus `exact`" are not simultaneously satisfiable, because
a template carries exactly one verifier. Blocker 3. This is additive: the seven named types are
implemented exactly as described, and `all_of` composes them.

**3. Modified `tsconfig.json`, which is shared configuration.** `tsc --noEmit` is a
definition-of-done item and it fails on a clean checkout of `main` — six `TS5097` errors in
`scripts/datasets/fetch.mts`, `scripts/verify-selfhosted.mts` and `scripts/verify-tournament.mts`,
which `yarn typecheck` never covered because it only runs the harness and tokenizers projects. The
alternatives were rewriting import specifiers in three files owned by Compare and Deploy, or
reporting the item as failed. Enabling `allowImportingTsExtensions` changes no runtime behaviour;
`tsx` already resolves those imports, which is why the scripts run today.

**4. Added `yarn test`, `yarn test:generate`, `yarn generate:spec-types` and
`yarn generate:spec-types:check` to the root `package.json`,** and a `./generate` subpath to
`packages/harness/package.json`. Both are additive; no existing script changed.

**5. Two small fixes to my own earlier work in this branch, found while writing the docs,** neither
of which touches Compare, Evolve or Deploy: the ledger prompt listed five of the six keys its schema
requires, so a model that followed the prompt exactly would have failed; and `verify` crashed with a
`TypeError` on a plain-text outputs file instead of saying which format it wanted.

**Not deviated from:** no UI, no route, no navigation change; no model API call and nothing that
costs money; no network access at generation or verification time; no non-English template content;
`LICENSE` and `NOTICE` untouched; no file deleted; no runtime dependency added to the TypeScript
app; Python absent from the `yarn install && yarn dev` path.

---

## The three things to do next

**1. Give a template a second locale and actually measure fertility with it.** Everything the
fertility argument depends on is built — identical parameters from identical seeds, wording as the
only variable, a hook that records tokenizer name and version — and none of it has been exercised,
because there is no second locale. Until one exists, the claim that these token counts are
comparable in a way corpus statistics are not is a design argument rather than a result. This needs
a native speaker, not an afternoon of work, which is exactly why it is first: it is the longest
lead time in the module and the only part that cannot be done unattended.

**2. Sandbox the executable tier, or fence it off explicitly.** `python_unittest` runs code from a
template with nothing but a subprocess and a timeout between it and the machine. Today that is
tolerable because the only templates are the three in this repository. It stops being tolerable the
moment templates are something people share, which is the entire point of a portable spec. Either
put a real boundary around it — a container, seccomp, or a separate uid with no filesystem or
network — or make the CLI refuse executable verifiers unless a `--i-trust-this-template` flag is
passed, and say so in the spec.

**3. Widen the conformance suite by generating cases rather than writing them.** The 289 cases were
authored by hand, which means they cover the divergences I thought of. The two real divergences
found during this work — the `1e21` canonical-JSON rejection and the UTF-16 key ordering — were
both caught by fixtures rather than by review, which is the strongest available evidence that
hand-authored coverage is not enough. A property-based generator producing random candidates and
comparing the two implementations' verdicts directly, rather than against an expected value, would
search a space no one has to imagine first. `scripts/generate-verdicts.mts` and
`scripts/generate_verdicts.py` are already the two halves of that comparison.

---

## Report 2 — pre-merge pass

*Originally `logs/SUMMARY-2.md`, reproduced in full. The log leakage findings are its first section.*

### Generate module — pre-merge pass

Branch `feat/generate-foundation`. Second unattended pass over work summarised in
[`SUMMARY.md`](#report-1--foundation).

---

## Log leakage findings, and the total size of `logs/`

**Nothing sensitive is present.** Reporting it first because that is where it belongs, and
because the finding below is the kind that looks like a hit until you read it.

`logs/` is **216 KB on disk, 182,187 bytes across 14 files**, of which one is this document
and one is the previous summary.

What was searched for, and what turned up:

| Looked for | Found |
| --- | --- |
| Absolute paths containing a username | 11 lines, one file, discussed below |
| Environment variable dumps (`^KEY=value`) | none |
| Tokens, API keys, bearer credentials, `ghp_`/`ghs_`/`github_pat`/`x-access-token` | none |
| Registry credentials (`_authToken`, `.npmrc`, `always-auth`) | none |
| URLs of any scheme, including internal hostnames | none |
| IPv4 addresses | none |
| The git remote's push credential | none |

The one finding is `logs/05-pip-install.log`, 11 lines of pip's "Requirement already
satisfied" output naming `/home/ubuntu/.local/lib/python3.12/site-packages`.

**Assessed as not sensitive, and step 8 proceeded.** The judgement, stated openly so it can
be overruled: `ubuntu` is the default unprivileged account on every Ubuntu cloud image. It
identifies no person, discloses no infrastructure, and grants no access. The only other
thing the path reveals is the Python minor version, which `pyproject.toml` already declares.
The instruction's controlling criterion is "material that must not enter permanent history",
and a distribution's default account name does not meet it.

Three things make this lower stakes than the judgement itself: no other file in `logs/`
contains the string; `SUMMARY.md` does not; and `logs/` is removed from the tree in the
final commit of this branch, with the branch marked for squash merge, so nothing reaches
`main`'s history in any case.

Grep for it and decide for yourself before merging — the file is
`logs/05-pip-install.log`, and the string is `/home/ubuntu`. If the judgement is wrong, the
remedy is not deleting the file: the blob is already reachable through this branch's
history and would need the branch rebuilt.

---

## What changed

### 1. The `tsconfig` fix is now on `main` as its own commit

`main` was failing `tsc --noEmit -p tsconfig.json` with six `TS5097` errors before this
branch existed, and had been for as long as the three offending scripts have imported a
sibling as `./thing.ts`. Nobody noticed because `yarn typecheck` runs the harness and
tokenizers projects only, and CI calls `yarn typecheck`, so the root project was never
type-checked anywhere.

Commit `2a921b2` on `main` adds the one line and nothing else. The
message states the pre-existing failure, lists the six errors, and explains why the flag is
preferable to rewriting three import specifiers: the specifiers are correct for the runtime
that actually executes them, and the flag is only legal in a project that never emits, which
this one does not.

`main` was then merged into this branch. The same line already existed here inside the CI
commit, and git resolved the two identical edits without a conflict.

### 2. `all_of` refuses an executable child before evaluating anything

The audit found the check was **lazy**, and lazy in the way that matters. Children were
validated as they were reached, so a declarative child that failed early returned its
verdict and an executable sibling behind it was never looked at. The composite reported a
result for output only part of the contract had been applied to, and nothing in that result
said which part went unexamined. TypeScript also raised the wrong error — a config error
rather than the unsupported-verifier error.

Both implementations now walk the whole composite to every depth first, and raise
`UnsupportedVerifierError` if any descendant is executable or unknown. The schema enforces
the same rule structurally: `all_of` children reference a new `verifier_declarative` union
rather than `verifier`, so an executable child now fails to load rather than failing at
scoring time.

14 rejection rows were added to the conformance suite, in a new `rejections` array with its
own schema definition, because a configuration that must be refused cannot be expressed in a
field typed as `#/$defs/verifier`. They cover both executable types, an executable behind a
failing sibling, an executable at the deepest permitted nesting, unknown and untagged
children, and nesting past the limit. Both suites assert the raise *and* that the lenient
path still returns a failure rather than a pass.

Depth coverage is exhaustive rather than representative: the corpus covers depths 0, 1, 2 and
8, and a parametrised test in each language covers **every** depth from 0 to
`MAX_ALL_OF_DEPTH`, with a passing declarative sibling at each level so a lazy implementation
would have something to return before reaching the executable child.

The assessment of whether `all_of` should exist at all is in
[`docs/decisions/0001-generate-foundation.md`](docs/decisions/0001-generate-foundation.md)
section 3a. Short version: a list-valued `verifier` field achieves the same thing and would
delete ten pieces of machinery including the recursion, the depth limit and the eager walk;
nesting is expressive power with no expressible difference; the recommendation is to make the
change before the spec is cited, and it was not made in this pass because it touches the
schema, both implementations, a template contract and 36 conformance rows.

### 3. The regex subset no longer contains anything engine-dependent

The old design pinned Python's `re.ASCII` semantics as normative and had TypeScript rewrite
each pattern to reproduce them. **The premise was wrong.** ASCII semantics say Devanagari
contains no word characters, that `०१२` are not digits, and that a Hangul string has no word
boundary anywhere in it. For a benchmark whose targets are Hindi, Hinglish and Korean, `\w`
was not a portability compromise — it was a wrong answer that looked like a working pattern,
and it looked like one on *both* implementations, so the conformance suite agreed with itself
all the way down. That is precisely the failure parity testing cannot detect.

What the subset now forbids, rejected at verify time with `invalid_pattern` and again at
template load time with an error naming the construct:

- `\w \W \d \D \b \B \s \S`. Write the class out: `[0-9]`, `[A-Za-z0-9_]`, `[\u0900-\u097F]`.
- `.` — Python excludes only `\n`, JavaScript also excludes `\r`, U+2028 and U+2029. Write
  `[^\n]`, or `[\u0000-\uffff]` for any character at all.
- `$` — Python's also matches before one trailing newline. Use `mode: full_match`, or the
  lookahead `(?![\u0000-\uffff])` where mode is unavailable, which both engines read
  identically including across a trailing newline.
- The `m` and `s` flags, which have nothing left to modify.
- The `i` flag on any non-ASCII pattern. This *closes* a divergence the previous pass had
  merely documented.

`^` stays; without `m` it is start of input in both engines.

**The TypeScript rewriting layer is deleted, not reduced.** Both sides now compile the
pattern verbatim, so what an author writes is what runs, and a test asserts the compiled
source equals the input so a translator cannot creep back in unnoticed.

`spec/conformance/regex.json` was rewritten: 75 cases, including Devanagari letters and
digits, precomposed Hangul, conjoining jamo, mixed-script Hinglish, and the specific
divergences that motivated each ban. Every expectation was computed by running `re` and
`RegExp` directly, side by side, **before** it was written down — not read off the
implementations.

### 4. The JSON Schema subset is checked against `ajv` and `jsonschema`

`ajv` is now a dev dependency, never imported by a shipped module, with a test asserting both
that no manifest lists it under `dependencies` and that no file under
`packages/harness/src/generate/` imports it.

The three-way argument, since no single test states it: the Python conformance suite proves
`jsonschema` matches each recorded expectation, the TypeScript conformance suite proves the
hand-written validator matches it, and the new oracle test proves `ajv` matches it too *and*
that `ajv` and the hand-written validator agree case by case. Two independent libraries
agreeing with both implementations is what rules out a shared misreading.

**No disagreements.** The disagreement tables are empty in both files.

The oracle was checked against a deliberate fault before being trusted: disabling the
`uniqueItems` branch in the TypeScript validator turns three oracle rows red, so the test
detects a real divergence rather than passing vacuously.

The Python side has no hand-written validator to test — `verify_json_schema` gates the schema
through the subset and then calls `jsonschema` — so its file proves the two things that *can*
be wrong there: that the hand-written gate never changes the library's verdict, and that the
library matches the recorded expectation. It says so rather than implying more.

### 5. The spec carries a draft notice

A blockquote at the top of `spec/verifiable-task-v1.md`, before anything else: the surface may
change in ways that break existing templates and generated sets until the preprint; the `v1`
identifier names the document's shape and not a promise; implementers and citers should pin a
commit rather than track the branch. It cites this pass's own breaking changes as evidence of
the scale still possible, because an abstract warning is easy to skip and a concrete one is
not.

### 6. Log hygiene

`BLOCKERS.md` became `docs/decisions/0001-generate-foundation.md` with content intact, plus a
status header and a note on why it moved. Superseded entries were revised in place *and say
so*, because a record showing only the final answer does not explain the answer. The README
Docs section points at `docs/decisions/`.

`logs/` is gitignored, with a comment recording the distinction: published evaluation run
logs belong versioned with a manifest, build output does not. Each conformance CI job tees
its output to `logs/` and uploads it with `actions/upload-artifact`, `if: always()`, 30-day
retention.

The workflow now sets `defaults.run.shell: bash` for `pipefail`. Without it the default step
shell reports `tee`'s exit code, so `pytest | tee` would have passed the build silently on a
failing suite. Verified: `bash -e -c 'false | tee /dev/null'` exits 0, `bash -eo pipefail`
exits 1.

---

## Definition of done

| Item | Result | Evidence |
| --- | --- | --- |
| Log leakage check, findings and size reported | done | top of this file |
| `tsc --noEmit` clean on `main`, standalone commit | pass | commit `2a921b2`; `02-typecheck.log` |
| All original definition-of-done checks pass | 12 of 12 | `01`–`12` logs, "all checks passed" |
| Conformance parity, new cases included | zero divergence, 329 rows | `10-zero-divergence.log` |
| `all_of` with an executable child raises, every permitted depth | pass, depths 0–8 | `04-yarn-test.log`, `06-pytest.log` |
| No shorthand regex class accepted by either implementation | pass | `test_regex_subset.py`, `generate-regex-subset.test.mts` |
| Pattern-rewriting layer removed | done | `regex-subset.ts` has no `rewrite` |
| Oracle test passes, or disagreements documented | pass, no disagreements | 125 rows each side |
| Spec carries an unambiguous draft notice | done | `spec/verifiable-task-v1.md:3` |
| Compare, Evolve, Deploy build output unchanged | byte-identical, 709 artifacts | `12-build-output-unchanged.log` |
| `docs/decisions/0001-generate-foundation.md` exists with prior content | done | `git mv`, content intact |
| `PR_DESCRIPTION.md` exists with both summaries | done | repo root |
| `logs/` gitignored and removed from the tree | done | `.gitignore`, final commit |

### Command output

**`bash scripts/verify-generate-dod.sh`** — all 12 checks pass.

```
=== 01-build-without-python   PASS
=== 02-typecheck              PASS
=== 03-workspace-typecheck    PASS
=== 04-yarn-test              PASS
=== 05-pip-install            PASS
=== 06-pytest                 PASS
=== 07-reproducible-emit      PASS
=== 08-example-set-current    PASS
=== 09-spec-types-drift       PASS
=== 10-zero-divergence        PASS
=== 11-existing-verifiers-unaffected  PASS
=== 12-build-output-unchanged PASS

all checks passed
```

**`tsc --noEmit` on `main`, before and after the standalone commit:**

```
$ git checkout main && npx tsc --noEmit -p tsconfig.json
scripts/datasets/fetch.mts(19,8): error TS5097: An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled.
scripts/datasets/fetch.mts(20,29): error TS5097: ...
scripts/datasets/fetch.mts(21,30): error TS5097: ...
scripts/verify-selfhosted.mts(17,34): error TS5097: ...
scripts/verify-tournament.mts(13,8): error TS5097: ...
scripts/verify-tournament.mts(15,38): error TS5097: ...
exit=2 (before fix, on main)

$ npx tsc --noEmit -p tsconfig.json
exit=0 (after fix, on main)
$ yarn typecheck
Done in 2.25s.
```

**Suites** (`04-yarn-test.log`, `06-pytest.log`):

```
# tests 522
# pass  522
# fail  0

601 passed in 2.08s
```

**Zero divergence** (`10-zero-divergence.log`):

```
TypeScript verdicts: 329 cases
Python verdicts:     329 cases

zero divergence
```

329 rather than the previous 305: the regex corpus grew from 51 to 75 cases, `all_of` gained
2 cases and 14 rejection rows, and the rejection rows are dumped through the same lenient
path so a refused configuration is compared across implementations too. The two malformed
configurations that raise rather than producing a verdict are recorded as
`["raises","verifier_config"]`, because turning a raise into a verdict inside the comparison
would hide exactly the difference the comparison exists to find.

**`all_of` refuses an executable child at every permitted depth** (`06-pytest.log`,
`04-yarn-test.log`):

```
test_conformance_rejection[all_of/rejects-sympy-equiv-child] PASSED
test_conformance_rejection[all_of/rejects-python-unittest-child] PASSED
test_conformance_rejection[all_of/rejects-executable-after-passing-declarative] PASSED
test_conformance_rejection[all_of/rejects-executable-after-failing-declarative] PASSED
test_conformance_rejection[all_of/rejects-executable-before-declarative] PASSED
test_conformance_rejection[all_of/rejects-executable-nested-one-deep] PASSED
test_conformance_rejection[all_of/rejects-executable-nested-two-deep] PASSED
test_conformance_rejection[all_of/rejects-executable-nested-two-deep-behind-a-failure] PASSED
test_conformance_rejection[all_of/rejects-executable-at-maximum-permitted-depth] PASSED
test_conformance_rejection[all_of/rejects-unknown-child-type] PASSED
test_conformance_rejection[all_of/rejects-child-with-no-type-tag] PASSED
test_conformance_rejection[all_of/rejects-unknown-type-nested-deep] PASSED
test_conformance_rejection[all_of/rejects-nesting-beyond-maximum-depth] PASSED
test_conformance_rejection[all_of/rejects-missing-verifiers-list] PASSED

ok  7 - an executable child 0 level(s) down makes the whole composite raise
ok  8 - an executable child 1 level(s) down makes the whole composite raise
ok  9 - an executable child 2 level(s) down makes the whole composite raise
ok 10 - an executable child 3 level(s) down makes the whole composite raise
ok 11 - an executable child 4 level(s) down makes the whole composite raise
ok 12 - an executable child 5 level(s) down makes the whole composite raise
ok 13 - an executable child 6 level(s) down makes the whole composite raise
ok 14 - an executable child 7 level(s) down makes the whole composite raise
ok 15 - an executable child 8 level(s) down makes the whole composite raise
```

**Shorthand classes refused by both implementations**, all eight, inside and outside a
character class, with the error naming the construct: 21 tests in `test_regex_subset.py`, 19
in `generate-regex-subset.test.mts`, and 12 of the corpus's 30 `invalid_pattern` cases. Nine
corpus cases carry Devanagari or Hangul text. Both engines were queried directly before any
expectation was written:

```
$ python3  (re, with re.ASCII)          $ node  (RegExp, no u flag)
'[0-9]+'    '१२३'      -> False          "[0-9]+"    "१२३"  -> false
'[०-९]+'    '१२३'      -> True           "[०-९]+"    "१२३"  -> true
'[ऀ-ॿ]+'    'नमस्ते'     -> True           "[ऀ-ॿ]+"    "नमस्ते"  -> true
'[가-힣]+'   '한글'      -> True           "[가-힣]+"   "한글"  -> true
'[a-z]+'    'K' (i)   -> False          "[a-z]+"    "K" i -> false
'a[^\n]b'   'a\rb'    -> True           "a[^\n]b"   "a\rb" -> true
'a[^\n]b'   'a\nb'    -> False          "a[^\n]b"   "a\nb" -> false
```

**Oracle test** — 125 assertions on each side, no disagreements, and a mutation check
proving it is not vacuous:

```
$ npx tsx --test scripts/test/generate-json-schema-oracle.test.mts
# tests 125
# pass  125
# fail  0

$ python3 -m pytest packages/generate/tests/test_json_schema_oracle.py -q
125 passed in 0.09s

# with the uniqueItems branch disabled in the TypeScript validator:
not ok 30 - ajv agrees with the subset validator: json_schema/unique-items-violation#28
not ok 31 - ajv agrees with the subset validator: json_schema/unique-items-numeric-equality#29
not ok 33 - ajv agrees with the subset validator: json_schema/unique-items-structural#31
# fail 3
```

**Compare, Evolve and Deploy build output** (`12-build-output-unchanged.log`). Next.js embeds
a random `BUILD_ID` and two freshly generated encryption keys, so a raw hash diff is noise;
`scripts/snapshot-build-output.py` normalises the build id away, five per-build random files
are excluded, and a control run of two identical builds proves the exclusion list is complete
rather than convenient:

```
--- build with the tsconfig line present
--- control: a second build of the identical tree
    two builds of the same tree agree on 709 artifacts,
    so a difference below would be attributable to the tsconfig line
--- build with the tsconfig line removed
    identical across 709 artifacts
56f1004297f951eae67a3da69f57b45d1db9cb89cd90b085087e9f2600f34c07  server/app/compare.html
cd0e2b9dfe4b2a2da67102670f2f878d590a1f7f0c367ffb5c7c760d3e550eb7  server/app/evolve.html
d0123c8a15b6993b017c255883663436369e2b16c769dcba1fdc8f74e05b7a47  server/app/deploy.html
```

Structurally it could not have differed either: no `tsconfig.json` in the repository extends
the root one, and the root project's `include` is `scripts/**` with `apps` and `packages`
explicitly excluded. The build was run anyway, because "it cannot have changed" and "it did
not change" are different claims and only one of them is evidence.

---

## Decisions taken without review

Full reasoning is in
[`docs/decisions/0001-generate-foundation.md`](docs/decisions/0001-generate-foundation.md).
New or revised in this pass:

1. **The `/home/ubuntu` path is not sensitive, so step 8 proceeded.** The reasoning is at the
   top of this file, deliberately, with the file and string named so the judgement can be
   checked in one grep.

2. **`main` was pushed directly**, because a commit that exists only on this VM does not
   satisfy "put that line on `main`", and the instruction was explicit. One commit, one line,
   nothing else.

3. **`all_of` rejection rows needed a new schema shape.** A configuration that must be refused
   cannot live in a field typed as `#/$defs/verifier`, so `conformance_file` gained an
   optional `rejections` array whose `verifier` is a bare object. The alternative — loosening
   `#/$defs/verifier` so invalid configurations validate — would have weakened the schema to
   describe the test suite.

4. **`.` and `$` were banned, which the instruction did not ask for.** It is entailed: with
   them in the subset the translator cannot be removed without reintroducing the divergence it
   existed to hide, so the real choice was between removing two constructs and keeping a
   rewriting layer for two constructs. Recorded as a deviation in decision 5, with the cost
   named: `^...$` inside a JSON Schema `pattern` is now `^...(?![\u0000-\uffff])`.

5. **The `i` flag is confined to ASCII-only patterns.** The previous pass documented the
   case-folding divergence and left it open. Confining the flag closes it, and costs nothing
   for the target scripts because Devanagari and Hangul are caseless.

6. **`jsonschema` `pattern` values in the corpus were rewritten** to use the portable
   end-of-input lookahead rather than `$`. Both engines were checked directly before the
   change: `^[A-Z]{2}-[0-9]{4}(?![\u0000-\uffff])` accepts `AB-1234` and rejects `AB-1234\n`
   in both, which `$` did not.

7. **A twelfth definition-of-done check was added** rather than verifying the build once by
   hand. A one-off check is not evidence for the next person to touch the shared config.

8. **`ajv` is pinned as a dev dependency at `^8.20.0`** and asserted never to reach a
   `dependencies` block. If that assertion ever fails, the claim that the subset is small
   enough to implement without a library is false, and the test is the only thing that would
   notice.

---

## Deviations from the prompt

- **`.` and `$` banned beyond the shorthand classes named.** Entailed by removing the
  rewriting layer; reasoning above and in decision 5.
- **`m` and `s` flag rejection is unit-tested rather than in the conformance corpus.** The
  schema now restricts `flags` to `["i"]`, so a corpus row asserting that `m` is refused could
  not itself validate. Tested in `test_regex_subset.py` and `generate-regex-subset.test.mts`,
  which say why in place.
- **The Python oracle test is not symmetric with the TypeScript one, and says so.** Python
  has no hand-written validator — it calls `jsonschema` — so a test comparing the two would
  check that a function equals itself. It proves the gate and the pivot instead. Pretending to
  symmetry would have been the worse choice.
- **The `all_of` assessment is recorded, not acted on**, as instructed.
- **`logs/` was regenerated during this pass**, so the files are this pass's output rather
  than the previous one's. `SUMMARY.md` was preserved unmodified.

---

## Three things I would do next

1. **Replace `all_of` with a list-valued `verifier` field, or decide not to and write down
   why.** Decision 3a makes the case; what it cannot do is choose. The window is open only
   until something cites the spec, and every conformance row added to `all_of` in the
   meantime raises the cost of the change. This is the most consequential open item on the
   branch and the one that gets harder fastest.

2. **Write the second locale, then find out what the spec got wrong.** Every claim about
   Hindi, Hinglish and Korean is currently a claim about English templates with Devanagari
   and Hangul in the conformance suite. The fertility hook has never measured two locales.
   The regex subset was redesigned around Devanagari and Hangul without a single template in
   either script. A real Hindi template would test whether the locale layer actually splits
   where the split was drawn, and it is the cheapest way to discover that it does not.

3. **Give the executable tier a sandbox, or remove it.** `python_unittest` runs
   model-produced code in the same process tree as the harness, with a timeout and nothing
   else. Decision 9 records this and it remains the largest unmitigated risk in the module.
   A benchmark that executes model output is a benchmark that will eventually execute
   something hostile, and "the operator consented" is not a control.
