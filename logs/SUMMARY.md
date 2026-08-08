# Generate module foundation — final report

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
