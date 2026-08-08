# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""The Python half of the cross-language conformance suite.

The TypeScript half runs the same files. If these two ever disagree, one of the two
implementations is wrong and the score of anything using it is unreliable, so a
divergence is a CI failure rather than a warning.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from redrob_generate.canonical import canonical_json
from redrob_generate.seed import derive_seed, seed_message
from redrob_generate.spec import find_spec_dir, validate_document
from redrob_generate.verify import DECLARATIVE_VERIFIER_TYPES, run_verifier

CONFORMANCE_DIR = find_spec_dir() / "conformance"
MINIMUM_CASES_PER_TYPE = 15

VERIFIER_FILES = sorted(
    path
    for path in CONFORMANCE_DIR.glob("*.json")
    if path.stem in DECLARATIVE_VERIFIER_TYPES
)


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _all_cases() -> list[tuple[str, dict]]:
    cases: list[tuple[str, dict]] = []
    for path in VERIFIER_FILES:
        for case in _load(path)["cases"]:
            cases.append((case["id"], case))
    return cases


ALL_CASES = _all_cases()


def test_every_declarative_type_has_a_conformance_file() -> None:
    """A verifier type without a case file is a type with no cross-language guarantee."""
    covered = {path.stem for path in VERIFIER_FILES}
    assert covered == set(DECLARATIVE_VERIFIER_TYPES), (
        f"missing conformance files for {sorted(set(DECLARATIVE_VERIFIER_TYPES) - covered)}"
    )


@pytest.mark.parametrize("path", VERIFIER_FILES, ids=lambda path: path.stem)
def test_conformance_file_is_well_formed(path: Path) -> None:
    document = _load(path)
    validate_document(document, "conformance_file")
    assert document["verifier_type"] == path.stem
    assert len(document["cases"]) >= MINIMUM_CASES_PER_TYPE, (
        f"{path.name} has {len(document['cases'])} cases, the spec requires at least "
        f"{MINIMUM_CASES_PER_TYPE}"
    )
    identifiers = [case["id"] for case in document["cases"]]
    assert len(identifiers) == len(set(identifiers)), f"{path.name} has duplicate case ids"
    for case in document["cases"]:
        assert case["verifier"]["type"] == path.stem, (
            f"{case['id']} declares a {case['verifier']['type']} verifier in {path.name}"
        )


def test_case_ids_are_globally_unique() -> None:
    identifiers = [identifier for identifier, _ in ALL_CASES]
    assert len(identifiers) == len(set(identifiers))


@pytest.mark.parametrize("case_id,case", ALL_CASES, ids=[case_id for case_id, _ in ALL_CASES])
def test_conformance_case(case_id: str, case: dict) -> None:
    verdict = run_verifier(case["verifier"], case["candidate"])
    expected = case["expected"]
    assert (verdict.passed, verdict.code) == (expected["passed"], expected["code"]), (
        f"{case_id}: expected {expected['passed']}/{expected['code']}, "
        f"got {verdict.passed}/{verdict.code} ({verdict.message})"
    )


# ------------------------------------------------------------------- fixtures


def test_seed_fixture() -> None:
    document = _load(CONFORMANCE_DIR / "seed-fixture.json")
    assert document["cases"], "the seed fixture is empty"
    for case in document["cases"]:
        message = seed_message(
            case["generator_version"], case["template_id"], case["instance_index"]
        )
        assert message.hex() == case["message_utf8_hex"], case
        assert hashlib.sha256(message).hexdigest() == case["sha256"], case
        seed = derive_seed(
            case["template_id"], case["instance_index"], case["generator_version"]
        )
        assert str(seed) == case["seed"], case
        assert 0 <= seed < 2**64


def test_seed_fixture_covers_distinct_inputs() -> None:
    """Different versions, ids and indices must not collide."""
    document = _load(CONFORMANCE_DIR / "seed-fixture.json")
    seeds = {case["seed"] for case in document["cases"]}
    assert len(seeds) == len(document["cases"])


def test_canonical_json_fixture() -> None:
    document = _load(CONFORMANCE_DIR / "canonical-json.json")
    assert document["cases"], "the canonical JSON fixture is empty"
    for case in document["cases"]:
        text = canonical_json(case["value"])
        assert text == case["canonical"], case["id"]
        assert hashlib.sha256(text.encode("utf-8")).hexdigest() == case["sha256"], case["id"]
