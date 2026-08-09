# Summary 3 — Unicode semantics audit, merge to main, verifier field refactor

Three parts, run sequentially. Part A on `feat/generate-foundation`, Part B a squash merge to
`main`, Part C on `refactor/verifier-list` off `main`.

`logs/` is gitignored and untracked, so nothing here is committed. It is written so the evidence
below can be regenerated rather than transcribed: `bash scripts/verify-generate-dod.sh`
reproduces every log referenced.

---

## Log leakage check

`logs/` is 296 KB across 13 `.log` files and 3 summaries. Scanned before writing this report.

| Looked for | Found |
| --- | --- |
| Anything matching `sk-`, `api[_-]?key`, `bearer`, `authorization:`, `password`, `secret`, `token=`, or a provider key name | Nothing. One false positive: `09-spec-types-drift.log` contains the word "matches". |
| IP addresses | None. |
| URLs | None. |
| Absolute paths outside the repository | 11 occurrences of `/home/ubuntu` in `05-pip-install.log`, all from pip's own output naming the interpreter and the wheel cache. |
| Model output, prompts, or evaluation content | None. No model was called at any point in this task; the module does not make network requests and `generate-no-network.test.mts` and `test_no_network.py` assert it by trapping socket creation. |

`logs/` is absent from `main`'s tree (`git ls-tree -r main --name-only | grep '^logs/'` → 0
matches) and is ignored by `.gitignore:113`.

---

# Part A — Unicode semantics audit

Full reasoning is in
[`docs/decisions/0002-unicode-semantics.md`](../docs/decisions/0002-unicode-semantics.md); this
section is the outcome and the evidence.

## A1. The end-of-input construct diverged on astral input, and is gone

**Proven, not assumed.** `^foo(?![\u0000-\uffff])` against `foo😀`:

| Runtime | Result | Why |
| --- | --- | --- |
| Python `re` | **matches** | A string is code points. U+1F600 is outside U+0000..U+FFFF, so the negative lookahead succeeds and `foo` is accepted as a full match of `foo😀`. |
| JavaScript `RegExp`, no `u` | **does not match** | A string is UTF-16 code units. The lead surrogate U+D83D is inside the range, so the lookahead fails. |

A failing corpus row was written before the fix.

**Fix, as the task specified.** `^` and `$` are banned in the standalone `regex` verifier; anchoring
is expressed through `mode: full_match` versus `mode: search`. Inside a JSON Schema `pattern` and
`patternProperties`, where `^...$` is idiomatic and there is no `mode` field to move the intent
into, both anchors are permitted and `$` is defined normatively as **absolute end of input**; the
Python implementation substitutes `\Z` for that one token.

**Why that is not the rewriter decision 0001 removed.** That rewriter modelled each engine's
reading of `.`, `^`, `$`, `\s` and the flag set — a second implementation of regex semantics,
needing its own conformance suite. This is one fixed token replaced by one fixed token, in one
dialect, in `regex_subset.to_python_source`. Recorded in decision 0002 §1a. Two corpus rows pin
it: `json_schema/pattern-dollar-excludes-a-trailing-newline` and
`json_schema/pattern-dollar-excludes-a-trailing-astral`, the second being the A1 defect kept as a
regression row.

JavaScript regexes are now compiled with the `u` flag, which is normative. Surrogate code points
and surrogate escapes are banned in patterns.

## A2. Comparison declared no normalisation form; the default is now NFC

`normalization` — `NFC` (default), `NFD`, `NFKC`, `NFKD`, `none` — on `exact`, `set_equality`,
`ordered_equality`, `format_constraint`, and `json_schema`. Applied to the candidate, to the
expected value, and to every string **and object key** inside a parsed JSON instance.

The default is the decision. `none` does nothing surprising and is the wrong default: a model
whose tokeniser emits decomposed jamo scores lower than one emitting precomposed jamo for the same
visible answer, and the difference is invisible in every log that will display it. The spec says
`none` exists for byte-exactness and has to be asked for.

A `json_schema` verifier **refuses a schema not already in the declared form** rather than
rewriting it. A `const` written in NFD under a verifier declaring NFC can never match anything;
that is a template bug, and rewriting it would make the template mean something its author did not
write.

**Both runtimes' normalisation tables were read in full** — all 1 112 064 code points, four forms,
compared entry by entry, by `scripts/unicode-tables.mts` and
`packages/generate/tests/test_unicode_parity.py`, which runs on every `pytest`.

| Form | Code points where the two disagree | All unassigned in the older UCD? |
| --- | --- | --- |
| NFC | **0** | — |
| NFD | 20 (U+105C9..U+16D6A) | yes |
| NFKC | 36 (U+1CCD6..U+1CCF9) | yes |
| NFKD | 56 (U+105C9..U+1CCF9) | yes |

CPython 3.12.3 (`unicodedata` 15.0.0) against Node v22.14.0 (ICU 76.1, Unicode 16.0). **No code
point that both sides consider assigned maps differently.** The test asserts NFC exactly with no
allowance, and asserts for the other three that every disagreement concerns a code point this
Python considers unassigned — a disagreement about an assigned character is a hard failure.

## A3. Length had no unit; `graphemes` is refused rather than approximated

`length_unit` — `codepoints` (default), `utf16`, `bytes_utf8` implemented; `graphemes` **specified
and refused with an error**.

Three options were available for `graphemes`: `Intl.Segmenter` plus a Python grapheme library; a
hand-rolled Python approximation; or refusal. The approximation is disqualified outright — it
would be wrong on exactly the emoji and conjunct sequences the unit exists for. The library option
is the one that looks right, and is refused because **the two implementations would be reading
different Unicode versions**, as A2 measures, and grapheme breaking is defined against a specific
version's property tables. Two breakers over two tables produce two lengths, one of them silently
scores a model, and no test comparing the two implementations against a corpus written in either
version would see it.

Cost, stated: a template that wants a human-meaningful length bound cannot have one. `codepoints`
over-counts every conjunct and every emoji sequence.

`bytes_utf8` is computed by arithmetic over code points rather than by an encoder, because
`TextEncoder` substitutes U+FFFD for a lone surrogate and `str.encode` refuses one; both reach
three bytes, but arithmetic makes them agree by construction.

Substring checks are normalisation-sensitive and consistent with A2: `format_constraint`
normalises the candidate and every configured substring to the declared form first.

## A4. Corpus baseline expanded, and the requirement is now a test

Astral, combining, ZWJ and mixed-script coverage is asserted by
`test_the_case_set_can_reach_a_unicode_divergence`, parametrised per file, rather than left to an
author to remember. The reason is A1: a corpus of Devanagari and Hangul is entirely BMP, so every
case agreed on both sides while the subset was broken.

Rows, cases plus rejections, before Part A and after Part C:

| File | Before A | After A | After C |
| --- | --- | --- | --- |
| `exact` | 27 | 39 | 39 |
| `numeric_tolerance` | 37 | 42 | 42 |
| `json_schema` | 58 | 73 | 73 |
| `regex` | 75 | 98 | 98 |
| `set_equality` | 34 | 45 | 45 |
| `ordered_equality` | 26 | 34 | 34 |
| `format_constraint` | 36 | 61 | 61 |
| `all_of` → `verifier_list` | 36 | 42 | 40 |
| **Total** | **329** | **434** | **432** |

## A5. Sweep, with a per-site verdict

Grepped both implementations for `len(`, `.length`, `charAt`, `charCodeAt`, string indexing,
`slice`, `substring`, and case mapping. Every site touching arbitrary text is listed with a
verdict in decision 0002 §6; sites operating on lists, dicts, token vectors or ASCII-only
intermediates are grouped as "not text".

Case mapping: `case_sensitive: false` routes through `str.lower()` and
`String.prototype.toLowerCase()`, both the **locale-independent** Unicode default mapping. Neither
`str.casefold()` nor `toLocaleLowerCase()` appears anywhere, and the spec now says so. The Turkish
trap was checked directly: `İ` (U+0130) lowercases to `i` + U+0307 on both sides, not to `i`, and
U+0131 is left unchanged by both. The full lowercase table was compared the same way as the
normalisation tables: 27 disagreeing code points, all unassigned in `unicodedata` 15.0.0; zero
that both consider assigned.

**The sweep found a defect that was not reported.** Unpaired surrogates in verifier
*configuration*:

```
format_constraint, required_substrings: ["\ud83d"], candidate: "😀"
  Python      → missing_required_substring
  TypeScript  → ok
```

U+D83D is the lead unit of the pair encoding U+1F600, so in JavaScript the needle *is* the first
half of the haystack and `includes` finds it, while in Python it is a character that is not there.
The same split runs through `split` against a lone-surrogate delimiter, which cuts an emoji in half
on one runtime and matches nothing on the other. There is no reading on which the two engines
agree, so the only answers were "refuse" or "diverge": **any unpaired surrogate anywhere in a
verifier's configuration is now refused**, checked once at dispatch so a field added later inherits
the rule. Candidates are deliberately exempt — a candidate is model output and must always yield a
verdict. Reproduced as a failing corpus row before the fix.

## Part A definition of done

| Item | Status |
| --- | --- |
| A failing test existed for each real defect before its fix | Yes — A1 (`$` on astral), the unpaired-surrogate divergence, and the A4 corpus shortfall each had a red row or a red test first |
| A1 resolved, outcome stated either way | Diverges; `^`/`$` banned in the verifier, `$` normative in JSON Schema `pattern` with a one-token `\Z` substitution |
| `normalization` and `length_unit` implemented, defaulted, specified | Yes; defaults `NFC` and `codepoints` |
| Corpus contains non-BMP, combining, ZWJ, mixed-script for every declarative verifier | Yes, enforced by a test |
| Zero divergence across the expanded corpus | Yes |
| A5 sweep complete with a per-site verdict | Yes, decision 0002 §6 |
| All prior checks still pass | Yes |
| Spec updated for every new field and normative decision | Yes |

---

# Part B — Merge to main

Squash merged `feat/generate-foundation` into `main` as one commit,
`4bddd21 Add Generate: parametric verifiable evaluation tasks`. The branch is preserved; nothing
was force-pushed and no history was rewritten.

**One file was excluded from the merge**, and this was a decision taken without review:
`PR_DESCRIPTION.md`, a working document written for a reviewer of the feature branch. It is not
part of the module and would have been permanent clutter at the repository root. It remains on
`feat/generate-foundation`. Nothing else was dropped.

## Verification on `main`, re-run for this report

Run in a clean `git worktree` of `main` with its own `node_modules` and its own virtualenv, so
nothing from the Part C branch could leak in.

| Check | Result |
| --- | --- |
| `yarn install && yarn build`, `python*` and `pip*` stripped from `PATH` | Passed. The shim confirmed `python3: not found`, `pip3: not found` before running. `yarn install --frozen-lockfile` → `Done in 5.31s`, `yarn build` → route table printed, `Done in 10.19s`. |
| `npx tsc --noEmit -p tsconfig.json` | Clean, no output |
| `yarn test` | `# tests 664`, `# pass 664`, `# fail 0` |
| `pytest packages/generate` | `763 passed in 3.27s` |
| Both conformance suites, as a diff of their actual verdicts | 532 rows each, **zero divergence** |
| `logs/` absent from `main` and gitignored | Absent; `.gitignore:113` |
| `docs/decisions/` present on `main` | `0001-generate-foundation.md`, `0002-unicode-semantics.md` |

Nothing failed, so no revert was needed.

A note on the counts: the first attempt at the stripped-PATH build failed with
`Symlink [project]/node_modules is invalid, it points out of the filesystem root`. That was an
artefact of my symlinking the main checkout's `node_modules` at `/workspace/node_modules` to save
an install, not a property of `main`. Repeated with a real install in the worktree, it passes. The
failed attempt is reported here rather than silently discarded because a build failure on `main`
would have required a revert under the task's own rules, and it should be visible that one was
seen and diagnosed rather than never encountered.

---

# Part C — List-valued verifier field

Branch `refactor/verifier-list` off `main`, left open for review, not merged. Full reasoning in
[`docs/decisions/0003-list-valued-verifier-field.md`](../docs/decisions/0003-list-valued-verifier-field.md).

## What changed

A verifier field — a template's `verifier`, an instance's `verifier`, a conformance row's
`verifier` — holds either one verifier object or an array of declarative verifiers. An array means
all must pass. Spec version bumped to `redrob-verifiable-task/v2`; the two spec files renamed
accordingly; §11.1 states the migration.

**Every element runs; there is no short circuit.** The overall `code` is still the first failure's,
verbatim, so no configuration `all_of` could express scores differently. The verdict additionally
carries `detail.elements`, one `{index, type, passed, code}` per element in list order.

**`detail.elements` is normative**, which is an exception to `detail` being advisory, and it was
made deliberately. It is a strictly stronger parity check than the overall verdict: an
implementation that reaches the right `code` by running the wrong elements, out of order, or by
stopping early agrees on `passed` and `code` and disagrees here. Both runners compare it entry for
entry, and the verdict dumps carry it, so it is part of the divergence diff.

**Executable elements are a schema violation, not a runtime refusal.** The array references
`#/$defs/verifier_declarative`; a template's array references
`#/$defs/verifier_binding_declarative`, whose type enum omits the executable tier. The runtime
refusal is kept as a second line of defence because dispatch is reachable without a schema check.
What is gone is the *eager pre-walk* that made the runtime refusal correct — with no short circuit,
every element is reached by construction.

**Arrays do not nest**, so there is no depth limit.

## Grep confirmation that `all_of` is gone

```
$ rg -n 'all_of|AllOf|MAX_ALL_OF' --hidden -g '!.git' -g '!logs/**' | rg -v '\ballOf\b'
spec/verifiable-task-v2.md:16:  ... and `all_of` was removed outright in favour of a
spec/verifiable-task-v2.md:  §11.1, describing the v1 → v2 migration
docs/decisions/0001-generate-foundation.md:  entry 3a, the recommendation this implements
docs/decisions/0002-unicode-semantics.md:  the A4 row-count table, historical
docs/decisions/0003-list-valued-verifier-field.md:  this change's own record
```

Every remaining occurrence is prose describing the removal. `allOf` was excluded from the grep
because it is a JSON Schema keyword the subset validator supports, and unrelated. No occurrence
remains in the schema, either implementation, the corpus, or any template.

## Templates migrated

| Template | Before | After |
| --- | --- | --- |
| `math/linear-equation` | `numeric_tolerance` | unchanged — proof the single form survives |
| `extraction/quarterly-ledger` | `all_of [json_schema, exact]` | `[json_schema, exact]` — mechanical |
| `format/release-note` | one `format_constraint` | `[format_constraint, format_constraint]` — **behaviour changed** |

`format/release-note` listed the banned word twice, in two casings produced by a `title()`
derivation, because `case_sensitive` applies to every substring check in one constraint at once and
the header check needs exact casing. That construction caught `seamless` and `Seamless` and missed
`SEAMLESS`. It is now a case-sensitive element for the length, line and header constraints and a
case-insensitive one for the banned word; the `banned_word_capitalised` derivation is deleted.

This is a scoring change to a template, not a syntax migration, and it is a decision taken without
review. Made because the old behaviour was a bug that existed only because the field could hold one
verifier — migrating a workaround for the constraint being removed would have been the wrong
outcome. The template is not published and the sets in this repository are examples. Residual: the
case-insensitive element lowercases, so decision 0002 §6a's version dependency now applies to it;
none of the six banned words contain anything outside ASCII.

## Net line count

Against `main`, with rename detection.

| Area | Added | Removed | Net |
| --- | --- | --- | --- |
| Implementation, both languages | 159 | 164 | **−5** |
| Generated types | 64 | 22 | +42 |
| Tests | 301 | 143 | +158 |
| Conformance corpus | 1122 | 1193 | **−71** |
| Schema | 137 | 36 | +101 |
| Spec prose | 94 | 41 | +53 |
| Templates | 57 | 49 | +8 |

Constructs removed:

| Construct | Where | Lines |
| --- | --- | --- |
| `verifier_all_of` definition | schema | 22 |
| `MAX_ALL_OF_DEPTH`, `assert_all_of_is_declarative`, `verify_all_of`, `_run_all_of` | `verify/declarative.py` | 67 |
| `MAX_ALL_OF_DEPTH`, `assertAllOfIsDeclarative`, `verifyAllOf`, `runAllOf` | `verifiers.ts` | 71 |
| `AllOfVerifier` type and its export | generated types, `index.ts` | 8 |
| depth-sweep tests | `test_verifiers.py`, `generate-unsupported.test.mts` | 55 |
| `all_of.json` | corpus | 1180 |

Replaced by `run_verifier_list` (53) and `runVerifierList` (38), five schema definitions totalling
85 lines, and `verifier_list.json` (1109).

**The claim in entry 3a was a reduction in the code that must be provably identical across two
languages, and that is where the reduction is: −5 lines of implementation, with recursion, the
depth limit, the eager tree walk and the tree-shaped rejection path gone from both sides.** The
corpus shrank by 71 lines while gaining four cases, two rejection rows and six schema rejections,
because a flat array is cheaper to write than nine levels of nesting. Tests and schema grew, for
reasons named in decision 0003 §6.

## New conformance surface

`spec/conformance/verifier_list.json`: 26 cases covering both shapes of the field, 8 runtime
rejections, and **6 `schema_rejections`** — a new row type asserting that a document is refused by
schema validation before any verifier runs, checked with `jsonschema` on the Python side and `ajv`
on the TypeScript side. Each carries a `valid_counterpart` the schema must accept, because a
rejection assertion is satisfied by a schema that rejects everything.

The JSON Schema oracle tests improved as a side effect. Under `all_of`, a nested `json_schema`
child inherited the *case's* expected verdict, which is the first failure's and not necessarily
that schema's, so those rows were skipped by the "the library agrees with the recorded
expectation" check. A list element carries its own recorded verdict, so those rows are now checked
rather than skipped.

## Part C definition of done

| Item | Status |
| --- | --- |
| `all_of` gone from spec, both implementations, and the corpus | Yes, confirmed by grep above |
| Array and single-object forms both work, per-element verdicts reported | Yes; a well-formedness test fails if the corpus stops covering both shapes |
| Executable element rejected by schema validation | Yes, 6 `schema_rejections` rows, both languages |
| Net line count reported, constructs listed | Above |
| Zero divergence, all suites pass | Yes |
| Spec version bumped, change documented | `redrob-verifiable-task/v2`, §11.1 |
| Branch left open for review, not merged | Yes |

---

# Command output, per checklist item

All from `bash scripts/verify-generate-dod.sh` on `refactor/verifier-list` at `0c2105d`. Full
output per step is in the named log.

```
=== 01-build-without-python      PASS  (logs/01-build-without-python.log)
=== 02-typecheck                 PASS  (logs/02-typecheck.log)
=== 03-workspace-typecheck       PASS  (logs/03-workspace-typecheck.log)
=== 04-yarn-test                 PASS  (logs/04-yarn-test.log)
=== 05-pip-install               PASS  (logs/05-pip-install.log)
=== 06-pytest                    PASS  (logs/06-pytest.log)
=== 07-reproducible-emit         PASS  (logs/07-reproducible-emit.log)
=== 08-example-set-current       PASS  (logs/08-example-set-current.log)
=== 09-spec-types-drift          PASS  (logs/09-spec-types-drift.log)
=== 10-zero-divergence           PASS  (logs/10-zero-divergence.log)
=== 11-existing-verifiers-unaffected  PASS  (logs/11-existing-verifiers-unaffected.log)
=== 12-build-output-unchanged    PASS  (logs/12-build-output-unchanged.log)
=== 13-negative-controls         PASS  (logs/13-negative-controls.log)

all checks passed
```

**`02-typecheck`** — `npx tsc --noEmit -p tsconfig.json`, no output, exit 0.

**`04-yarn-test`**

```
# tests 659
# pass 659
# fail 0
```

**`06-pytest`**

```
============================= 761 passed in 3.39s ==============================
```

**`09-spec-types-drift`**

```
$ tsx scripts/generate-spec-types.mts --check
spec-types.generated.ts matches spec/verifiable-task-v2.schema.json
```

**`10-zero-divergence`** — the two implementations' actual verdicts, dumped and diffed, rather
than inferred from two green suites.

```
TypeScript verdicts: 553 cases
Python verdicts:     553 cases

zero divergence
```

The 553 rows are 432 corpus rows plus regex token-stream signatures plus the per-element reports
introduced by Part C.

**`13-negative-controls`**

```
all 11 negative controls detected their break
```

---

# A negative control for every invariance claim

Every "the two implementations agree" claim in this module rests on a comparison, and a comparison
is evidence only if a difference would have been noticed. `scripts/negative-controls.sh` introduces
one difference per claim, runs the check that should catch it, and asserts that the check fails.
**A control that passes is the failure**: it means the check it guards cannot fail and therefore
proves nothing. Every edit is made to a copy, applied, and reverted in a trap.

| # | Claim | Break | Detected by |
| --- | --- | --- | --- |
| 1 | The two implementations produce the same verdict for every conformance case | Removed the TypeScript regex scanner's surrogate-pair reassembly | Verdict dump diff |
| 2 | The token stream comparison sees scanner drift that verdicts alone do not | Mislabelled group tokens as literals in the TypeScript scanner | 0 verdict rows differ, **2 token rows differ** |
| 3 | Python's `unicodedata.normalize` and `String.prototype.normalize` agree on NFC everywhere | Changed one entry (U+00C5) of the JavaScript NFC table in the dump | `test_unicode_parity.py::…nfc_agrees…`: "NFC differs on 1 code point(s): U+00C5 (Lu)" |
| 4 | Every declarative verifier's case set contains input where the runtimes could differ | Deleted every non-ASCII row from `exact.json` | `exact.json has no case containing a ZWJ sequence or a combining sequence or a mixed-script string or an astral character` |
| 5 | The hand-written subset validator agrees with `ajv` on every corpus schema | Made `maxLength` count UTF-16 code units instead of code points | Two oracle rows: "this validator says false and ajv says true" |
| 6 | `spec-types.generated.ts` is what the schema generates | Renamed one generated field | `yarn generate:spec-types:check` |
| 7 | Two emits of the same template are byte-identical | Added `os.urandom(4)` to the seed derivation | `diff -r` of two emits |
| 8 | The element report comparison sees a short circuit that case verdicts do not | Made the TypeScript verifier list stop at its first failing element | **0 case verdict rows differ, 8 element rows differ** |
| 8b | An executable element behind a failing one is still refused | The same break | `verifier_list/rejects-executable-after-failing-declarative` fails in the TypeScript suite |
| 9 | An executable element of a verifier list is refused by schema validation | Pointed the list's `items` at `#/$defs/verifier` instead of `#/$defs/verifier_declarative` | Four `schema_rejection` rows stop raising |
| 10 | A schema-rejection row also proves the schema accepts the valid counterpart | Made one `valid_counterpart` invalid | `SpecError: verifier_or_list is invalid at (root)` |

Controls 2 and 8 are the interesting ones, because in both the *primary* comparison stays green.
Control 2 is why the verdict dumps carry regex token streams: a pattern can tokenise differently
and still match or fail to match the same candidate. Control 8 is the Part C analogue: a
short-circuiting implementation reaches the same overall code on every case, because the overall
code is the first failure's either way, and only the element report shrinks.

Control 8 also produced a result worth stating plainly. The break changes **one** overall verdict,
on the rejection row `rejects-executable-after-failing-declarative`, where a short-circuiting
implementation never reaches the executable element and returns a mismatch instead of refusing.
That is the exact scenario the eager pre-walk existed for, and it confirms empirically that
removing the short circuit is what makes removing the walk safe, rather than the two changes merely
both being green. It is split out as control 8b.

Controls 9 and 10 are a pair. 9 asserts the schema refuses what it should; 10 asserts it is not
refusing everything.

---

# Unicode assumptions I could not fully verify

Separate from the ones fixed above. These are open, and each is a place where the parity evidence
this module produces is weaker than it looks.

**1. `NFD`, `NFKC` and `NFKD` are only reproducible across runtimes carrying the same Unicode
version.** Measured, not suspected: 20, 36 and 56 disagreeing code points respectively between
CPython 3.12.3 (UCD 15.0.0) and Node v22.14.0 (ICU 76.1, Unicode 16.0). Every disagreement is
about a character one database has and the other does not, and the test asserts that. But the
guarantee I can make is "these two runtimes, at these two versions"; a template declaring one of
those three forms is not portable across a runtime upgrade, and no test in this repository can
detect that in advance. Closing it means pinning one Unicode version across both runtimes — an ICU
pin plus a CPython pin, or a vendored UCD — which is a dependency decision.

**2. `case_sensitive: false` carries the same version dependency**, bounded the same way: 27
disagreeing code points, all unassigned in UCD 15.0.0, zero assigned in both. It is also arguably
inconsistent with having removed the regex `i` flag, which was removed because *no* configuration
of the two engines agrees on case folding. The difference is that the regex divergence concerned
characters both engines know (`re.IGNORECASE` folds U+0131 to `i`; a `RegExp` with `iu` does not),
and this one is version skew. A reviewer wanting strict consistency should remove
`case_sensitive: false` entirely; the cost is that "Answer" and "answer" become different answers.

**3. The `graphemes` unit is specified and unimplemented, and I cannot say what it would measure.**
Grapheme breaking is defined against a specific Unicode version's property tables, so
`Intl.Segmenter` and any Python library would be reading different tables. I do not know how large
the disagreement is: unlike the normalisation and lowercase tables, I did not enumerate it, because
there is no Python grapheme implementation in the dependency tree to enumerate against. The refusal
is a decision made *because* the size is unknown, not one informed by knowing it.

**4. `Intl.Segmenter`'s behaviour is not pinned by anything I control**, which is the same problem
one level up: even a TypeScript-only grapheme feature would vary with the Node build's ICU.

**5. The two verdicts agreeing does not prove the two are right.** This is the shape of the two
defects that reached a green build in the previous pass. The `json_schema` verifier now has a
differential oracle — `jsonschema` and `ajv` — so for that one verifier there is a third opinion.
The other six declarative verifiers have no oracle. `exact`, `set_equality`, `ordered_equality` and
`format_constraint` are simple enough that I believe the risk is low, and the honest statement is
that "I believe the risk is low" is what I said before A1 as well.

**6. The corpus coverage test checks that a *property* is present, not that a *divergence* is
reachable.** `test_the_case_set_can_reach_a_unicode_divergence` asserts each file contains an
astral character, a combining sequence, a ZWJ sequence and a mixed-script string. That is a proxy.
A file can satisfy all four with rows that exercise a code path where the two runtimes cannot
differ. Making the test real would mean mutation-testing the corpus — deliberately breaking each
implementation and requiring some row to notice — which is control 1 done per verifier rather than
globally, and is the single highest-value thing left undone here.

**7. Normalisation is applied to the parsed JSON instance, and JSON parsing itself is assumed to
agree.** `json.loads` and `JSON.parse` are compared only through their effect on verdicts. Lone
surrogates in a JSON string literal (`"\ud83d"`) are the obvious candidate for a difference:
`JSON.parse` produces an unpaired surrogate, and Python's `json` also accepts it. The
configuration-side unpaired-surrogate refusal does not cover candidates, deliberately, so this path
is live. No corpus row exercises a lone surrogate in a *candidate's* JSON, and I did not add one
because I could not predict the answer well enough to write the expectation without reading it back
off an implementation.

**8. `bytes_utf8` is computed by arithmetic, which agrees by construction and is therefore not
independently checked.** Both sides run the same formula over code points. If the formula is wrong,
both are wrong identically and the parity test is silent. It is four branches over code point
ranges and I have read it on both sides, which is not the same as having tested it against an
encoder — and testing it against an encoder is precisely what was rejected, because the encoders
disagree on lone surrogates.

**9. The spec whitespace set is asserted to be BMP and non-surrogate, and that is a static
property of a list I wrote.** The `slice`-based trim in TypeScript is safe because no member of
that set can appear inside a surrogate pair. Nothing enforces that if a character is added to the
set later.
