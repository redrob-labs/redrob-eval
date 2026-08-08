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
import unicodedata
from pathlib import Path

import pytest

from redrob_generate.canonical import canonical_json
from redrob_generate.errors import SpecError, UnsupportedVerifierError
from redrob_generate.seed import derive_seed, seed_message
from redrob_generate.spec import find_spec_dir, validate_document
from redrob_generate.verify import (
    DECLARATIVE_VERIFIER_TYPES,
    run_verifier,
    run_verifier_or_fail,
)

CONFORMANCE_DIR = find_spec_dir() / "conformance"
MINIMUM_CASES_PER_TYPE = 15

#: Names a conformance file may carry: one per declarative verifier, plus the
#: list-valued verifier field, which is a shape of the field rather than a verifier type
#: and so has no entry in the registry.
CORPUS_NAMES = frozenset(DECLARATIVE_VERIFIER_TYPES) | {"verifier_list"}

VERIFIER_FILES = sorted(
    path for path in CONFORMANCE_DIR.glob("*.json") if path.stem in CORPUS_NAMES
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


def _all_schema_rejections() -> list[tuple[str, dict]]:
    rows: list[tuple[str, dict]] = []
    for path in VERIFIER_FILES:
        for case in _load(path).get("schema_rejections", []):
            rows.append((case["id"], case))
    return rows


ALL_CASES = _all_cases()
ALL_REJECTIONS = _all_rejections()
ALL_SCHEMA_REJECTIONS = _all_schema_rejections()


def test_every_declarative_type_has_a_conformance_file() -> None:
    """A verifier type without a case file is a type with no cross-language guarantee."""
    covered = {path.stem for path in VERIFIER_FILES}
    assert covered == CORPUS_NAMES, f"missing conformance files for {sorted(CORPUS_NAMES - covered)}"


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
    rows = document["cases"] + document.get("rejections", [])
    if path.stem == "verifier_list":
        # This file tests a shape of the verifier field rather than a verifier type, so its
        # rows carry whatever types the shape is being exercised with. What it must contain
        # is both shapes: a corpus of only lists would leave the single form unchecked.
        shapes = {isinstance(case["verifier"], list) for case in document["cases"]}
        assert shapes == {True, False}, f"{path.name} does not cover both shapes of the field"
        return
    for case in rows:
        assert not isinstance(case["verifier"], list), (
            f"{case['id']} is a verifier list, which belongs in verifier_list.json"
        )
        assert case["verifier"].get("type") in {path.stem, None}, (
            f"{case['id']} declares a {case['verifier'].get('type')} verifier in {path.name}"
        )


def _strings_in(value: object):
    """Every string inside a JSON value, object keys included."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for entry in value:
            yield from _strings_in(entry)
    elif isinstance(value, dict):
        for key, entry in value.items():
            yield key
            yield from _strings_in(entry)


def _script_of(character: str) -> str | None:
    """A coarse script bucket, covering the scripts this corpus actually uses.

    Not UAX #24. Characters UAX #24 calls Common or Inherited — ASCII digits, punctuation,
    spaces, combining marks — return ``None``, so "42 rupees" does not count as two scripts
    on the strength of its digits.
    """
    value = ord(character)
    if 0x0041 <= value <= 0x024F:
        return "Latin"
    if 0x0370 <= value <= 0x03FF:
        return "Greek"
    if 0x0400 <= value <= 0x04FF:
        return "Cyrillic"
    if 0x0590 <= value <= 0x05FF:
        return "Hebrew"
    if 0x0600 <= value <= 0x06FF:
        return "Arabic"
    if 0x0900 <= value <= 0x097F:
        return "Devanagari"
    if 0x1100 <= value <= 0x11FF or 0x3130 <= value <= 0x318F or 0xAC00 <= value <= 0xD7AF:
        return "Hangul"
    if 0x3040 <= value <= 0x30FF:
        return "Kana"
    if 0x4E00 <= value <= 0x9FFF or 0x20000 <= value <= 0x2A6DF:
        return "Han"
    if 0x2600 <= value <= 0x27BF or 0x1F000 <= value <= 0x1FAFF:
        return "Emoji"
    return None


#: The four properties every declarative verifier's case set must be able to exercise.
CORPUS_PROPERTIES = {
    "an astral character": lambda text: any(ord(c) > 0xFFFF for c in text),
    "a combining sequence": lambda text: any(
        unicodedata.category(c) in ("Mn", "Mc", "Me") and index > 0
        for index, c in enumerate(text)
    ),
    "a ZWJ sequence": lambda text: "\u200d" in text,
    "a mixed-script string": lambda text: len(
        {script for script in (_script_of(c) for c in text) if script}
    )
    >= 2,
}


@pytest.mark.parametrize("path", VERIFIER_FILES, ids=lambda path: path.stem)
def test_the_case_set_can_reach_a_unicode_divergence(path: Path) -> None:
    """Every verifier's corpus must contain input where the two runtimes could differ.

    This is a rule about the corpus rather than about either implementation, and it exists
    because its absence hid a real defect. The subset's end-of-input construct diverged on
    the first astral character anyone would have tried, and the corpus was entirely within
    the Basic Multilingual Plane — Devanagari and Hangul both are — so every case agreed on
    both sides while the construct was broken. A corpus that cannot reach a divergence is
    not evidence that there is none.
    """
    document = _load(path)
    found: dict[str, str] = {}
    for case in document["cases"] + document.get("rejections", []):
        texts = list(_strings_in(case["candidate"])) + list(_strings_in(case["verifier"]))
        for name, predicate in CORPUS_PROPERTIES.items():
            if name not in found and any(predicate(text) for text in texts):
                found[name] = case["id"]
    missing = sorted(set(CORPUS_PROPERTIES) - set(found))
    assert not missing, f"{path.name} has no case containing {' or '.join(missing)}"


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

    # The per-element report is normative for a list, and the rest of ``detail`` is not.
    # Comparing it is what makes the report evidence: an implementation that reaches the
    # right overall verdict by running the wrong elements, or by stopping early, agrees on
    # ``code`` and disagrees here.
    if isinstance(case["verifier"], list):
        assert "elements" in expected, f"{case_id} is a list and declares no element report"
        assert verdict.detail.get("elements") == expected["elements"], (
            f"{case_id}: element report is {verdict.detail.get('elements')}"
        )
    else:
        assert "elements" not in expected, f"{case_id} is not a list and declares elements"
        assert "elements" not in verdict.detail, (
            f"{case_id}: a single verifier must not report elements"
        )


@pytest.mark.parametrize(
    "case_id,case",
    ALL_SCHEMA_REJECTIONS,
    ids=[case_id for case_id, _ in ALL_SCHEMA_REJECTIONS],
)
def test_conformance_schema_rejection(case_id: str, case: dict) -> None:
    """A document the schema must refuse, and a near-identical one it must accept.

    A runtime refusal and a structural one are different guarantees. The first holds for
    callers that reach this dispatcher; the second holds for anything that validates the
    document, including tools this project did not write. Both halves of the row are
    checked, because a rejection test passes trivially if the schema rejects everything.
    """
    with pytest.raises(SpecError):
        validate_document(case["document"], case["definition"])
    validate_document(case["valid_counterpart"], case["definition"])


def test_schema_rejections_cover_the_executable_element_rule() -> None:
    assert ALL_SCHEMA_REJECTIONS, "the schema rejection suite is empty, so it proves nothing"


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


def test_rejections_are_not_merely_failing_verdicts() -> None:
    """Guard against the check being satisfied by a mismatch that happens to be false.

    Every rejection here names a configuration that is invalid, so a mismatch verdict
    would mean the verifier ran and judged the candidate, which is the behaviour these
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
