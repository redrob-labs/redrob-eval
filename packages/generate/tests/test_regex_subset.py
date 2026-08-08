# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""The parts of the regex subset that cannot be expressed as conformance rows.

A case file's verifier must validate against ``#/$defs/verifier``, and the schema now
restricts ``flags`` to ``["i"]``, so a row asserting that ``m`` and ``s`` are refused could
not be written there. It is asserted here instead, and mirrored by
``scripts/test/generate-regex-subset.test.mts``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from redrob_generate.errors import SpecError
from redrob_generate.spec import load_template
from redrob_generate.verify import run_verifier
from redrob_generate.verify.regex_subset import (
    SUPPORTED_FLAGS,
    RegexSubsetError,
    validate,
    validate_flags,
)

SHORTHAND = ["\\w", "\\W", "\\d", "\\D", "\\b", "\\B", "\\s", "\\S"]
CLASS_SHORTHAND = ["\\w", "\\W", "\\d", "\\D", "\\s", "\\S"]


@pytest.mark.parametrize("shorthand", SHORTHAND)
def test_shorthand_is_refused_outside_a_character_class(shorthand: str) -> None:
    with pytest.raises(RegexSubsetError) as caught:
        validate(f"a{shorthand}b")
    message = str(caught.value)
    assert "shorthand class" in message
    # The error names the offending construct, so the author does not have to guess which
    # of several escapes in a long pattern was the problem.
    assert shorthand in message


@pytest.mark.parametrize("shorthand", CLASS_SHORTHAND)
def test_shorthand_is_refused_inside_a_character_class(shorthand: str) -> None:
    # \b and \B are assertions rather than class shorthands, so they are meaningless
    # inside a character class and only the six class shorthands are checked there.
    with pytest.raises(RegexSubsetError):
        validate(f"[{shorthand}-]")


def test_the_m_and_s_flags_are_gone() -> None:
    for flag in ("m", "s"):
        with pytest.raises(RegexSubsetError, match="not in the portable subset"):
            validate_flags("abc", [flag])
    assert SUPPORTED_FLAGS == ("i",)


def test_the_i_flag_is_refused_on_a_non_ascii_pattern() -> None:
    validate_flags("abc", ["i"])
    with pytest.raises(RegexSubsetError, match="ASCII-only pattern"):
        validate_flags("été", ["i"])
    # Without the flag the same pattern is fine; it is the folding that is unportable.
    validate("été")


def test_an_out_of_subset_flag_reaches_the_verdict_as_invalid_pattern() -> None:
    verdict = run_verifier({"type": "regex", "pattern": "abc", "flags": ["m"]}, "abc")
    assert verdict.passed is False
    assert verdict.code == "invalid_pattern"


def test_the_portable_end_assertion() -> None:
    """(?![\\u0000-\\uffff]) replaces '$', which the two engines read differently.

    Python's '$' also matches before one trailing newline. The lookahead does not, in
    either engine, which is the whole reason it is the recommended spelling.
    """
    verifier = {"type": "regex", "pattern": "^ab(?![\\u0000-\\uffff])", "mode": "search"}
    assert run_verifier(verifier, "ab").passed is True
    assert run_verifier(verifier, "ab\n").passed is False
    assert run_verifier(verifier, "abc").passed is False


def test_a_template_with_a_shorthand_class_fails_to_load(tmp_path: Path) -> None:
    """Load time, not scoring time.

    A pattern that uses a shorthand class is wrong for every instance the template will
    ever produce. Finding out at scoring time means the set is already published.
    """
    template = {
        "spec_version": "redrob-verifiable-task/v1",
        "id": "test.shorthand",
        "version": "1.0.0",
        "locale": "en",
        "description": "A template with an unportable pattern.",
        "prompt": "Write a number.",
        "parameters": [],
        "verifier": {"type": "regex", "pattern": "\\d+"},
    }
    path = tmp_path / "template.json"
    path.write_text(json.dumps(template), encoding="utf-8")

    with pytest.raises(SpecError) as caught:
        load_template(path)
    assert "\\d" in str(caught.value)
    assert "outside the portable subset" in str(caught.value)


def test_a_template_with_a_portable_pattern_loads(tmp_path: Path) -> None:
    template = {
        "spec_version": "redrob-verifiable-task/v1",
        "id": "test.portable",
        "version": "1.0.0",
        "locale": "en",
        "description": "The same template written explicitly.",
        "prompt": "Write a number.",
        "parameters": [],
        "verifier": {"type": "regex", "pattern": "[0-9]+"},
    }
    path = tmp_path / "template.json"
    path.write_text(json.dumps(template), encoding="utf-8")
    assert load_template(path)["id"] == "test.portable"


def test_a_devanagari_class_survives_a_round_trip_through_the_scanner() -> None:
    """The motivating case. \\d would have rejected these digits under the ASCII reading
    the previous revision pinned, and accepted them under Python's default."""
    verifier = {"type": "regex", "pattern": "[\\u0966-\\u096f]+"}
    assert run_verifier(verifier, "\u0967\u0968\u0969").passed is True
    assert run_verifier({"type": "regex", "pattern": "[0-9]+"}, "\u0967\u0968\u0969").passed is False
