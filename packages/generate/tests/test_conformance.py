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
from redrob_generate.errors import UnsupportedVerifierError
from redrob_generate.seed import derive_seed, seed_message
from redrob_generate.spec import find_spec_dir, validate_document
from redrob_generate.verify import (
    DECLARATIVE_VERIFIER_TYPES,
    run_verifier,
    run_verifier_or_fail,
)

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


def _all_rejections() -> list[tuple[str, dict]]:
    rejections: list[tuple[str, dict]] = []
    for path in VERIFIER_FILES:
        for case in _load(path).get("rejections", []):
            rejections.append((case["id"], case))
    return rejections


ALL_CASES = _all_cases()
ALL_REJECTIONS = _all_rejections()


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
    for case in document["cases"] + document.get("rejections", []):
        assert case["verifier"].get("type") in {path.stem, None}, (
            f"{case['id']} declares a {case['verifier'].get('type')} verifier in {path.name}"
        )


def test_case_ids_are_globally_unique() -> None:
    identifiers = [identifier for identifier, _ in ALL_CASES + ALL_REJECTIONS]
    assert len(identifiers) == len(set(identifiers))


@pytest.mark.parametrize("case_id,case", ALL_CASES, ids=[case_id for case_id, _ in ALL_CASES])
def test_conformance_case(case_id: str, case: dict) -> None:
    verdict = run_verifier(case["verifier"], case["candidate"])
    expected = case["expected"]
    assert (verdict.passed, verdict.code) == (expected["passed"], expected["code"]), (
        f"{case_id}: expected {expected['passed']}/{expected['code']}, "
        f"got {verdict.passed}/{verdict.code} ({verdict.message})"
    )


@pytest.mark.parametrize(
    "case_id,case", ALL_REJECTIONS, ids=[case_id for case_id, _ in ALL_REJECTIONS]
)
def test_conformance_rejection(case_id: str, case: dict) -> None:
    """A refused configuration must raise, and must never produce a passing verdict.

    Both halves matter. The raise is the contract for a caller that wants to know its
    verifier is unusable; the verdict is what a caller scoring a whole set gets instead of
    an aborted run. Neither is allowed to be a pass.
    """
    expected_error = UnsupportedVerifierError if case["raises"] == "unsupported_verifier" else ValueError
    with pytest.raises(expected_error):
        run_verifier(case["verifier"], case["candidate"])

    if case["raises"] == "unsupported_verifier":
        verdict = run_verifier_or_fail(case["verifier"], case["candidate"])
        assert (verdict.passed, verdict.code) == (
            case["expected"]["passed"],
            case["expected"]["code"],
        ), f"{case_id}: got {verdict.passed}/{verdict.code}"
        assert verdict.passed is False


def test_all_of_rejections_are_not_merely_failing_verdicts() -> None:
    """Guard against the check being satisfied by a mismatch that happens to be false.

    Every rejection here names a configuration that is invalid, so a mismatch verdict
    would mean the composite ran and judged the candidate, which is the behaviour these
    cases exist to forbid.
    """
    assert ALL_REJECTIONS, "the rejection suite is empty, so it proves nothing"
    for case_id, case in ALL_REJECTIONS:
        assert case["expected"]["passed"] is False, case_id
        assert case["expected"]["code"] == "unsupported_verifier", case_id


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
