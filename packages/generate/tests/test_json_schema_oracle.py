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

2. **The recorded expectation equals raw** ``jsonschema``. That fact is the pivot the
   TypeScript oracle test leans on: it proves ``ajv`` also matches the expectation, so
   together the two files establish that the hand-written TypeScript validator, ``ajv``
   and ``jsonschema`` all agree. Two independent libraries are what rule out a shared
   misreading, which parity between the two implementations never could.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import jsonschema
import pytest

from redrob_generate.spec import find_spec_dir
from redrob_generate.verify import run_verifier
from redrob_generate.verify.json_schema_subset import SchemaSubsetError, validate_schema_document

CONFORMANCE = find_spec_dir() / "conformance"

#: Cases where a disagreement with ``jsonschema`` is intentional and correct. Empty, and it
#: should stay that way. An entry here is a claim that the subset reads the specification
#: better than a mature library, so each one needs the reasoning written out.
DOCUMENTED_DISAGREEMENTS: dict[str, str] = {}


def _collect() -> list[tuple[str, Any, str, dict]]:
    """Every json_schema verifier in the corpus, including those nested in an all_of."""
    rows: list[tuple[str, Any, str, dict]] = []

    def walk(verifier: Any, case_id: str, candidate: str, expected: dict) -> None:
        if not isinstance(verifier, dict):
            return
        if verifier.get("type") == "json_schema":
            rows.append((f"{case_id}#{len(rows)}", verifier["schema"], candidate, expected))
            return
        if verifier.get("type") == "all_of":
            for child in verifier.get("verifiers", []):
                walk(child, case_id, candidate, expected)

    for name in ("json_schema.json", "all_of.json"):
        document = json.loads((CONFORMANCE / name).read_text(encoding="utf-8"))
        for case in document["cases"]:
            walk(case["verifier"], case["id"], case["candidate"], case["expected"])
    return rows


ROWS = _collect()


def test_the_oracle_corpus_is_not_empty() -> None:
    assert len(ROWS) >= 40, f"only {len(ROWS)} json_schema rows found"


@pytest.mark.parametrize("row", ROWS, ids=[row[0] for row in ROWS])
def test_the_subset_gate_does_not_change_the_library_verdict(row: tuple) -> None:
    row_id, schema, candidate, _expected = row
    try:
        parsed = json.loads(candidate)
    except ValueError:
        # A candidate that is not JSON never reaches schema evaluation.
        return

    # The gate must accept every schema in the corpus. A rejection here is a subset that
    # cannot express its own test cases.
    try:
        validate_schema_document(schema)
    except SchemaSubsetError as exc:  # pragma: no cover - a failure is the message
        pytest.fail(f"{row_id}: the subset gate rejected a corpus schema: {exc}")

    library = jsonschema.Draft202012Validator(schema).is_valid(parsed)
    mine = run_verifier({"type": "json_schema", "schema": schema}, candidate).passed

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
    row_id, schema, candidate, expected = row
    try:
        parsed = json.loads(candidate)
    except ValueError:
        return
    # Only meaningful where the whole case turns on this schema. A row nested in an all_of
    # may be preceded by a sibling that fails first, so the case-level expectation is not
    # this schema's verdict.
    if not row_id.startswith("json_schema/"):
        return
    assert jsonschema.Draft202012Validator(schema).is_valid(parsed) == expected["passed"], (
        f"{row_id}: jsonschema disagrees with the recorded expectation"
    )
