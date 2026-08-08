# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""The parts of the regex subset that cannot be expressed as conformance rows.

A case file's verifier must validate against ``#/$defs/verifier``, and the schema has no
``flags`` property at all now, so a row asserting that a flag is refused could not be
written there. The same goes for the recorded engine-level facts below, which are about
``re`` rather than about a verifier.

Mirrored by ``scripts/test/generate-regex-subset.test.mts``.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from redrob_generate.errors import SpecError
from redrob_generate.spec import load_template
from redrob_generate.verify import run_verifier
from redrob_generate.verify.regex_subset import (
    SUPPORTED_FLAGS,
    RegexSubsetError,
    scan,
    to_python_source,
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


def test_the_subset_has_no_flags_at_all() -> None:
    assert SUPPORTED_FLAGS == ()
    for flag in ("i", "m", "s", "u", "g"):
        with pytest.raises(RegexSubsetError, match="no flags at all"):
            validate_flags([flag])
    validate_flags([])


@pytest.mark.parametrize("flag", ["i", "m"])
def test_an_out_of_subset_flag_reaches_the_verdict_as_invalid_pattern(flag: str) -> None:
    verdict = run_verifier({"type": "regex", "pattern": "abc", "flags": [flag]}, "abc")
    assert verdict.passed is False
    assert verdict.code == "invalid_pattern"


def test_case_folding_is_gone_because_no_configuration_of_the_two_engines_agrees() -> None:
    """The recorded fact behind dropping 'i'.

    Under the u flag a JavaScript RegExp folds with Unicode simple case folding, which
    agrees with Python's IGNORECASE on the Kelvin sign, the long s and final sigma, and
    disagrees on U+0131. Nothing in a pattern can exclude a candidate character, so the
    flag went rather than the guarantee.
    """
    assert re.fullmatch("i", "\u0131", re.IGNORECASE) is not None
    assert re.fullmatch("i", "\u0130", re.IGNORECASE) is not None
    # The JavaScript half of this pair is in generate-regex-subset.test.mts; both are
    # false there. Written out as an explicit class, the two engines agree exactly.
    assert run_verifier({"type": "regex", "pattern": "[iI]"}, "\u0131").passed is False


def test_the_verifier_dialect_has_no_anchors() -> None:
    for pattern in ("^abc", "abc$", "^abc$"):
        verdict = run_verifier({"type": "regex", "pattern": pattern}, "abc")
        assert verdict.passed is False
        assert verdict.code == "invalid_pattern"
    # full_match is how the same intent is written, and it excludes a trailing newline.
    assert run_verifier({"type": "regex", "pattern": "abc"}, "abc").passed is True
    assert run_verifier({"type": "regex", "pattern": "abc"}, "abc\n").passed is False


def test_the_schema_pattern_dialect_admits_anchors_and_rewrites_only_the_dollar() -> None:
    r"""The one translation in the whole subset, stated as one assertion.

    '$' is normatively the absolute end of input. Python's '$' also matches before one
    trailing newline and '\Z' does not, so the token is rewritten and nothing else is.
    """
    validate("^ab$", dialect="schema_pattern")
    assert to_python_source("^ab$", "schema_pattern") == "^ab\\Z"
    assert to_python_source("a[$]b", "schema_pattern") == "a[$]b"
    assert re.search(to_python_source("^ab$", "schema_pattern"), "ab") is not None
    assert re.search(to_python_source("^ab$", "schema_pattern"), "ab\n") is None
    # Python's own '$' is the thing being avoided: it matches the trailing newline case.
    assert re.search("^ab$", "ab\n") is not None


def test_astral_input_is_one_atom_in_both_engines() -> None:
    """The A1 defect, stated as behaviour.

    The old end-of-input assertion (?![\\u0000-\\uffff]) matched "foo" in "foo\U0001F600"
    here and not in JavaScript, because a RegExp without the u flag reads the lead
    surrogate as a character inside the range. Both sides are on code points now.
    """
    assert run_verifier({"type": "regex", "pattern": "[\\u0000-\\uffff]+"}, "\U0001F600").passed is False
    assert run_verifier({"type": "regex", "pattern": "[^a]"}, "\U0001F600").passed is True


def test_surrogate_escapes_and_unpaired_surrogates_are_out_of_the_subset() -> None:
    for pattern in ("\\ud83d\\ude00", "[\\ud800-\\udfff]", "a\ud83db"):
        with pytest.raises(RegexSubsetError):
            validate(pattern)
    validate("a\U0001F600b")


def test_escapes_are_confined_to_what_a_regexp_accepts_under_u() -> None:
    for pattern in ("\\-", "\\ ", "\\#", "\\@", "\\_"):
        with pytest.raises(RegexSubsetError):
            validate(pattern)
    for pattern in ("\\.", "\\$", "\\^", "\\|", "\\/", "\\(", "\\)", "\\[", "\\]"):
        validate(pattern)
    validate("[a\\-z]")


def test_the_null_escape_is_out_because_python_reads_it_as_octal() -> None:
    assert re.fullmatch("\\01", chr(1)) is not None  # the reason
    for pattern in ("\\0", "\\01"):
        with pytest.raises(RegexSubsetError):
            validate(pattern)
    validate("\\x00")


def test_a_quantified_lookahead_is_refused() -> None:
    # A syntax error under the u flag and a silent no-op here.
    assert re.compile("(?=a)*") is not None
    for pattern in ("(?=a)*", "(?!a)+"):
        with pytest.raises(RegexSubsetError):
            validate(pattern)
    validate("(?:a)*")


@pytest.mark.parametrize(
    "pattern", ["a[^\\n]b", "(cat|dog)s?", "[A-Fa-f0-9]{6}", "\\$[0-9]+\\.[0-9]{2}"]
)
def test_a_scan_concatenates_back_to_its_input(pattern: str) -> None:
    """What makes the single '$' rewrite auditable: everything else is emitted verbatim."""
    assert "".join(token.text for token in scan(pattern)) == pattern
    assert to_python_source(pattern) == pattern


def test_a_template_with_a_shorthand_class_fails_to_load(tmp_path: Path) -> None:
    """Load time, not scoring time.

    A pattern that uses a shorthand class is wrong for every instance the template will
    ever produce. Finding out at scoring time means the set is already published.
    """
    template = {
        "spec_version": "redrob-verifiable-task/v2",
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
        "spec_version": "redrob-verifiable-task/v2",
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
