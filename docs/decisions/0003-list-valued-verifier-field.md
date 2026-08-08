# 0003. The verifier field is list-valued; `all_of` is gone

Status: **decided and implemented**.
Supersedes: entry 3a of `0001-generate-foundation.md`, which recorded this as a recommendation
awaiting a human.
Superseded by: nothing.
Applies to: `spec/verifiable-task-v2.md`, `spec/verifiable-task-v2.schema.json`,
`spec/conformance/verifier_list.json`, both implementations, and all three templates.

Entry 3a assessed the list as the better design and deferred the change because it touches the
schema, both implementations, a template's contract and 36 conformance rows. It has now been made.
This record covers what was decided while making it, since none of those decisions were reviewed.

---

## 1. Every element runs. There is no short circuit.

`all_of` returned the first failing child's verdict and stopped. A list runs every element and
reports each one. Overall `passed` and `code` are unchanged — the code is still the first
failure's, verbatim — so no configuration `all_of` could express scores differently under v2.

**Why not keep the short circuit.** Two reasons, and the second is the one that decided it.

The per-element report is only meaningful if every element has a verdict. A report that stops at
the first failure says "element 0 failed" and nothing about elements 1..n, which is what a
collapsed boolean already said.

More importantly, the short circuit hid unusable configurations. Under `all_of`,
`[exact, regex-with-an-unclosed-group]` against a wrong answer returned `mismatch` and never
compiled the pattern. A template that could not be scored was indistinguishable from an answer
that was merely wrong, and it stayed that way for every instance of that template until someone
happened to submit a correct answer. `spec/conformance/verifier_list.json` now carries that exact
row (`an-unusable-pattern-behind-a-failing-element-is-still-reported`) with both element verdicts
recorded, and its mirror image with the elements reordered so the second verdict cannot be an
artefact of position.

**Cost.** A list of expensive verifiers does more work on a failing candidate. Nothing in this
module is expensive — the declarative tier is string and JSON work on one candidate — so this was
not weighed further.

## 2. `detail.elements` is normative, unlike the rest of `detail`

`message` and `detail` were advisory precisely so an implementation could improve its diagnostics
without breaking parity. Making one key of `detail` normative is an exception, and it was made
deliberately.

A per-element report that two implementations disagree about is worse than no report, because it
is machine-readable and a consumer will act on it. And it is a strictly stronger parity check than
the overall verdict: an implementation that reaches the right `code` by running the wrong elements
— or by stopping early, or by evaluating them out of order — agrees on `passed` and `code` and
disagrees on `elements`. The conformance runner compares it entry for entry on both sides.

`expected.elements` is required in a corpus row whose verifier is a list, and forbidden otherwise.
A one-element list and a bare verifier are therefore different documents with different verdicts,
which is asserted in both suites.

**Reverse by** demoting `elements` to advisory in `#/$defs/verdict` and deleting the comparison in
both runners. That would restore the freedom to change the report, and lose a check that has no
substitute.

## 3. Executable elements are refused structurally, and still refused at runtime

The array references `#/$defs/verifier_declarative`; a template's array references
`#/$defs/verifier_binding_declarative`, whose type enum omits `sympy_equiv` and
`python_unittest`. A document with an executable element fails schema validation in any
validator, before this project's code is reached.

The runtime refusal was kept as well, because dispatch is reachable without a schema check — the
Python and TypeScript entry points both accept a raw mapping. What is gone is the *eager pre-walk*
that made the runtime refusal correct. `all_of` needed one: with a short circuit, an executable
child behind a failing declarative sibling was never reached, so the whole tree had to be walked
before anything was evaluated. Without a short circuit every element is reached by construction,
so the check sits inline in the loop and the walk is deleted. The corpus row that motivated the
walk (`rejects-executable-after-failing-declarative`) is still there and still passes.

**The asymmetry is deliberate and is asserted.** A bare verifier field may name an executable
type; an array may not. `verifier_list/schema-keeps-the-executable-asymmetry` fails if either half
changes. A single executable verifier is a task a non-Python implementation cannot score, and it
says so loudly. An executable element among declarative ones is a way to obtain a verdict from
partially checked output.

## 4. A new kind of conformance row: `schema_rejections`

A runtime refusal and a structural one are different guarantees, and the corpus could only express
the first. `schema_rejections` rows carry a `document` that must fail validation against a named
`$defs` entry, and a `valid_counterpart` that must pass. The counterpart is not decoration: a
rejection assertion is satisfied by a schema that rejects everything, so without it the row could
pass for the wrong reason. Both halves are checked by `jsonschema` on the Python side and `ajv` on
the TypeScript side, which is the second use of a general validator in the suite and, like the
first, dev-dependency only.

## 5. Migration of the three templates

- `math/linear-equation` — unchanged, single `numeric_tolerance`. Proof that the single form
  survives.
- `extraction/quarterly-ledger` — `{"type": "all_of", "verifiers": [A, B]}` became `[A, B]`.
  Mechanical.
- `format/release-note` — **changed behaviour, deliberately.** It had one `format_constraint`
  listing the banned word twice, in two casings produced by a `title()` derivation, because
  `case_sensitive` applies to every substring check in a constraint at once and the header check
  needs exact casing. That construction caught `seamless` and `Seamless` and missed `SEAMLESS`.
  It is now two elements: a case-sensitive one for the length, line and header constraints, and a
  case-insensitive one for the banned word. The `banned_word_capitalised` derivation is deleted.

  This is a scoring change to a template, not just a syntax migration. It was made because the old
  behaviour was a bug that only existed because the field could hold one verifier, and leaving it
  in place would have meant migrating a workaround for the constraint being removed. The template
  is not published and the generated sets in this repository are examples.

  Residual: `case_sensitive: false` lowercases, and record 0002 §6 documents that lowercasing
  carries a Unicode-version dependency bounded to code points one runtime considers unassigned.
  That dependency now applies to this template. None of the six banned words contain anything
  outside ASCII.

## 6. What was removed, and the line count

| Construct | Where | Lines |
| --- | --- | --- |
| `verifier_all_of` definition | schema | 22 |
| `MAX_ALL_OF_DEPTH`, `assert_all_of_is_declarative`, `verify_all_of`, `_run_all_of` | `verify/declarative.py` | 67 |
| `MAX_ALL_OF_DEPTH`, `assertAllOfIsDeclarative`, `verifyAllOf`, `runAllOf` | `verifiers.ts` | 71 |
| `AllOfVerifier` type and its export | generated types, `index.ts` | 8 |
| depth sweep tests | `test_verifiers.py`, `generate-unsupported.test.mts` | 55 |
| `all_of.json` | corpus | 1180 |

Replaced by `run_verifier_list` (53 lines) and `runVerifierList` (38 lines), five schema
definitions totalling 85 lines, and `verifier_list.json` (1109 lines).

Net, against `main`, with renames detected:

| Area | Added | Removed | Net |
| --- | --- | --- | --- |
| Implementation (both languages) | 159 | 164 | **−5** |
| Generated types | 64 | 22 | +42 |
| Tests | 301 | 143 | +158 |
| Conformance corpus | 1122 | 1193 | **−71** |
| Schema | 137 | 36 | +101 |
| Spec prose | 94 | 41 | +53 |
| Templates | 57 | 49 | +8 |

**The headline claim in entry 3a was a reduction in the code that must be provably identical
across two languages, and that is what happened: −5 lines of implementation, and the recursion,
the depth limit, the eager tree walk and the tree-shaped rejection path are all gone from both
sides.** Everything else grew, and the two largest increases are not overhead:

- Tests, +158, because the executable-element sweep changed from a depth sweep to a position
  sweep and four assertions were added for the per-element report.
- Schema, +101, because the structural rejection of executable elements needs a declarative
  binding definition, and the per-element report needs a shape.

The corpus shrank by 71 lines while gaining four cases, two rejection rows and six schema
rejections, because a flat array is cheaper to write than nine levels of nesting.

## 7. Unresolved

**Composition is no longer a value.** Entry 3a named this as the real loss and it is still real: a
future `any_of`, or a per-field verifier inside a structured comparison, cannot reuse a
field-shaped composition the way it could reuse a verifier-shaped one. If the tier grows either,
this decision has to be revisited, and adding composition back after removing it is worse than
never having removed it. Nothing in the current design says either is coming.

**`verifier_type` in a conformance file is now a misnomer for one file.** `verifier_list.json`
carries `"verifier_type": "verifier_list"`, which is not a verifier type. Renaming the field to
`corpus` would be correct and would touch every corpus file and both runners for no behavioural
gain; left as is, with the tests naming the exception explicitly rather than silently accepting
any string.

**The empty list passes.** It is the identity element, and it is also a template that checks
nothing while reporting `ok`. The schema permits it, one corpus row asserts it, and no template
uses it. A `minItems: 1` would remove the footgun and the identity element together; not applied,
because a generated verifier list built from an empty set of constraints is a legitimate thing for
a future template to produce and failing it at load time would be surprising.
