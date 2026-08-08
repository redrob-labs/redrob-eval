# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""The Python half of the JSON Schema oracle check.

**What this can and cannot prove.** The Python implementation does not hand-write a
validator: ``verify_json_schema`` gates the schema through the documented subset and then
hands the work to ``jsonschema``. There is therefore no second opinion to seek here, and a
test that ran the corpus through ``jsonschema`` and compared it to a verifier that calls
``jsonschema`` would be checking that a function equals itself.

Two things are worth proving on this side, and this file proves them.

1. **The subset gate never changes the library's verdict.** A gate that rejects a schema
   the library handles, or that lets through a schema whose meaning the TypeScript side
   reads differently, is the only way the Python path can be wrong. This is a real check
   because the gate is hand-written even though the validator is not.

2. **The recorded expectation equals** ``jsonschema`` **run on the normatively prepared
   inputs.** That fact is the pivot the TypeScript oracle test leans on: it proves ``ajv``
   also matches the expectation, so together the two files establish that the hand-written
   TypeScript validator, ``ajv`` and ``jsonschema`` all agree. Two independent libraries
   are what rule out a shared misreading, which parity between the two implementations
   never could.

"Prepared" means the two pre-steps the spec puts in front of schema evaluation, and
nothing else: the instance is normalised to the declared form, and ``$`` inside a
``pattern`` becomes ``\\Z`` because the spec defines it as the absolute end of input and
Python's ``$`` also matches before one trailing newline. Both are one-line, auditable
transforms rather than a general rewriter, and
:func:`test_the_preparation_is_load_bearing` names the corpus rows whose verdict changes
without them, so neither can quietly become a no-op.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import jsonschema
import pytest

from redrob_generate.spec import find_spec_dir
from redrob_generate.verify import run_verifier
from redrob_generate.verify.base import DEFAULT_NORMALIZATION, normalize_json_strings
from redrob_generate.verify.declarative import _schema_for_python
from redrob_generate.verify.json_schema_subset import SchemaSubsetError, validate_schema_document

CONFORMANCE = find_spec_dir() / "conformance"

#: Cases where a disagreement with ``jsonschema`` is intentional and correct. Empty, and it
#: should stay that way. An entry here is a claim that the subset reads the specification
#: better than a mature library, so each one needs the reasoning written out.
DOCUMENTED_DISAGREEMENTS: dict[str, str] = {}


def _collect() -> list[tuple[str, Any, str, dict, str]]:
    """Every json_schema verifier in the corpus, including elements of a verifier list.

    A list element carries its own recorded verdict in ``expected["elements"]``, so unlike
    the combinator this replaced, a nested schema's expectation is that schema's
    expectation rather than the case's leading code.
    """
    rows: list[tuple[str, Any, str, dict, str]] = []

    def take(verifier: Any, row_id: str, candidate: str, expected: dict) -> None:
        if not isinstance(verifier, dict) or verifier.get("type") != "json_schema":
            return
        rows.append(
            (
                row_id,
                verifier["schema"],
                candidate,
                expected,
                verifier.get("normalization", DEFAULT_NORMALIZATION),
            )
        )

    for name in ("json_schema.json", "verifier_list.json"):
        document = json.loads((CONFORMANCE / name).read_text(encoding="utf-8"))
        for case in document["cases"]:
            verifier = case["verifier"]
            if isinstance(verifier, list):
                for index, element in enumerate(verifier):
                    element_verdict = case["expected"].get("elements", [])[index]
                    take(element, f"{case['id']}[{index}]", case["candidate"], element_verdict)
                continue
            take(verifier, case["id"], case["candidate"], case["expected"])
    return rows


ROWS = _collect()


def _library_verdict(schema: Any, parsed: Any, form: str, *, prepared: bool = True) -> bool:
    """``jsonschema``'s answer, optionally without the spec's two pre-steps."""
    if prepared:
        schema = _schema_for_python(schema)
        parsed = normalize_json_strings(parsed, form)
    return jsonschema.Draft202012Validator(schema).is_valid(parsed)


def test_the_oracle_corpus_is_not_empty() -> None:
    assert len(ROWS) >= 40, f"only {len(ROWS)} json_schema rows found"


@pytest.mark.parametrize("row", ROWS, ids=[row[0] for row in ROWS])
def test_the_subset_gate_does_not_change_the_library_verdict(row: tuple) -> None:
    row_id, schema, candidate, _expected, form = row
    try:
        parsed = json.loads(candidate)
    except ValueError:
        # A candidate that is not JSON never reaches schema evaluation.
        return

    # The gate must accept every schema in the corpus. A rejection here is a subset that
    # cannot express its own test cases.
    try:
        validate_schema_document(schema, normalization=form)
    except SchemaSubsetError as exc:  # pragma: no cover - a failure is the message
        pytest.fail(f"{row_id}: the subset gate rejected a corpus schema: {exc}")

    library = _library_verdict(schema, parsed, form)
    mine = run_verifier(
        {"type": "json_schema", "schema": schema, "normalization": form}, candidate
    ).passed

    if mine != library:
        reason = DOCUMENTED_DISAGREEMENTS.get(row_id)
        assert reason, (
            f"{row_id}: the verifier says {mine} and jsonschema says {library}, so the "
            "subset gate changed the answer rather than merely restricting it"
        )
        return
    assert mine == library


@pytest.mark.parametrize("row", ROWS, ids=[row[0] for row in ROWS])
def test_the_library_agrees_with_the_recorded_expectation(row: tuple) -> None:
    """The pivot the TypeScript oracle test relies on."""
    row_id, schema, candidate, expected, form = row
    try:
        parsed = json.loads(candidate)
    except ValueError:
        return
    assert _library_verdict(schema, parsed, form) == expected["passed"], (
        f"{row_id}: jsonschema disagrees with the recorded expectation"
    )


def test_the_preparation_is_load_bearing() -> None:
    """The negative control for the two pre-steps.

    Without them the library's answer is a different answer on real corpus rows, which is
    the only thing that makes the prepared comparison above evidence rather than a
    definition. The rows are named so that a future change removing a pre-step fails here
    with the reason rather than silently weakening the oracle.
    """
    changed: list[str] = []
    for row_id, schema, candidate, _expected, form in ROWS:
        try:
            parsed = json.loads(candidate)
        except ValueError:
            continue
        if _library_verdict(schema, parsed, form) != _library_verdict(
            schema, parsed, form, prepared=False
        ):
            changed.append(row_id)
    assert changed, (
        "the corpus contains no row where normalising the instance or rewriting '$' "
        "changes jsonschema's verdict, so the prepared comparison proves nothing"
    )
    # A row per pre-step, named rather than counted.
    assert any("pattern-dollar" in row_id for row_id in changed), changed
    assert any("composition-forms" in row_id for row_id in changed), changed
