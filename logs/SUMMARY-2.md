# Generate module — pre-merge pass

Branch `feat/generate-foundation`. Second unattended pass over work summarised in
[`SUMMARY.md`](SUMMARY.md).

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
[`docs/decisions/0001-generate-foundation.md`](../docs/decisions/0001-generate-foundation.md)
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
[`docs/decisions/0001-generate-foundation.md`](../docs/decisions/0001-generate-foundation.md).
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
