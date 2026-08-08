# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""Shared verifier primitives, per spec section 6.0.

Every helper here exists because Python and JavaScript disagree about something:
whitespace sets, line terminators, string length, number parsing. Each one is written
out explicitly rather than delegated to a language built-in, so the two implementations
can be read side by side and checked against each other.
"""

from __future__ import annotations

import math
import re
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

# Spec whitespace. Written out instead of using \s or str.isspace(), both of which
# cover different sets in the two runtimes.
SPEC_WHITESPACE = (
    "\t\n\v\f\r \u0085\u00a0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000"
)
_WHITESPACE_RUN = re.compile(f"[{re.escape(SPEC_WHITESPACE)}]+")

VERDICT_CODES = (
    "ok",
    "mismatch",
    "not_a_number",
    "out_of_tolerance",
    "nan_mismatch",
    "infinity_mismatch",
    "invalid_json",
    "schema_violation",
    "no_match",
    "invalid_pattern",
    "parse_error",
    "cardinality_mismatch",
    "element_mismatch",
    "length_out_of_bounds",
    "line_count_out_of_bounds",
    "missing_required_substring",
    "forbidden_substring_present",
    "unsupported_verifier",
)


@dataclass(frozen=True)
class Verdict:
    """One verifier's answer.

    ``passed`` and ``code`` are normative and are what the conformance suite compares.
    ``message`` and ``detail`` are for humans and are deliberately not compared, so that
    an implementation can improve its diagnostics without breaking cross-language
    agreement.
    """

    passed: bool
    code: str
    message: str = ""
    detail: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {"passed": self.passed, "code": self.code}
        if self.message:
            result["message"] = self.message
        if self.detail:
            result["detail"] = self.detail
        return result


def ok(message: str = "") -> Verdict:
    return Verdict(True, "ok", message)


def fail(code: str, message: str = "", **detail: Any) -> Verdict:
    if code not in VERDICT_CODES:
        raise ValueError(f"{code!r} is not a spec verdict code")
    return Verdict(False, code, message, detail)


def find_unpaired_surrogate(text: str) -> int:
    """Index of the first unpaired surrogate code unit in ``text``, or ``-1``.

    A well-formed surrogate pair is not reported; a lead with no trail, a trail with no
    lead, and a lead followed by another lead all are.
    """
    index = 0
    length = len(text)
    while index < length:
        value = ord(text[index])
        if 0xD800 <= value <= 0xDBFF:
            if index + 1 < length and 0xDC00 <= ord(text[index + 1]) <= 0xDFFF:
                index += 2
                continue
            return index
        if 0xDC00 <= value <= 0xDFFF:
            return index
        index += 1
    return -1


def require_well_formed(value: Any, where: str = "verifier configuration") -> None:
    """Refuse a configuration containing an unpaired surrogate, anywhere inside it.

    An unpaired surrogate is not a character, and the two runtimes disagree about what it
    is instead. Python holds a string as code points, so ``"\\ud83d" in "\\U0001f600"`` is
    false; JavaScript holds one as UTF-16 code units, so
    ``"\\u{1f600}".includes("\\ud83d")`` is true, because the needle is literally the first
    half of the haystack. The same split happens in ``String.prototype.split`` against a
    lone-surrogate delimiter. Neither engine is wrong about its own model of a string and
    no amount of care in the verifier reconciles them, so a configuration that can only
    mean two things is refused rather than evaluated.

    Candidates are deliberately not checked. A candidate is model output and must always
    produce a verdict; and an unpaired surrogate in a candidate is harmless on its own,
    because the divergence needs the *needle* to be the half of a pair.
    """
    if isinstance(value, str):
        position = find_unpaired_surrogate(value)
        if position >= 0:
            raise ValueError(
                f"{where} contains an unpaired surrogate U+{ord(value[position]):04X} at "
                f"index {position}. It is not a character, and a Python implementation "
                "matching by code point and a JavaScript one matching by UTF-16 code unit "
                "give opposite answers for it"
            )
        return
    if isinstance(value, Mapping):
        for key, entry in value.items():
            require_well_formed(key, where)
            require_well_formed(entry, where)
        return
    if isinstance(value, (list, tuple)):
        for entry in value:
            require_well_formed(entry, where)


def strip_spec_whitespace(text: str) -> str:
    return text.strip(SPEC_WHITESPACE)


def collapse_spec_whitespace(text: str) -> str:
    return _WHITESPACE_RUN.sub(" ", text)


def normalize_line_endings(text: str) -> str:
    """CRLF then lone CR become LF. Nothing else is a line terminator here."""
    return text.replace("\r\n", "\n").replace("\r", "\n")


def code_point_length(text: str) -> int:
    """Length in code points. Python strings already count this way; TypeScript does not."""
    return len(text)


#: Units a length bound can be expressed in, per spec section 6.1.
LENGTH_UNITS = ("codepoints", "utf16", "graphemes", "bytes_utf8")

#: ``graphemes`` is specified and refused rather than approximated. See
#: docs/decisions/0002-unicode-semantics.md: this interpreter's ``unicodedata`` is at one
#: Unicode version and the JavaScript runtime's ICU is at another, so two UAX #29
#: implementations drawn from different tables would disagree on exactly the sequences a
#: grapheme count exists to get right.
UNSUPPORTED_LENGTH_UNITS = frozenset({"graphemes"})


def utf16_length(text: str) -> int:
    """Length in UTF-16 code units, which is what ``String.prototype.length`` returns."""
    return sum(2 if ord(character) > 0xFFFF else 1 for character in text)


def utf8_byte_length(text: str) -> int:
    """Length in UTF-8 bytes, counted from code points rather than from an encoder.

    Python refuses to encode a lone surrogate and ``TextEncoder`` silently substitutes
    U+FFFD for one. Both answers are three bytes, but arriving there by arithmetic means
    the two implementations agree by construction rather than by coincidence.
    """
    total = 0
    for character in text:
        value = ord(character)
        if value < 0x80:
            total += 1
        elif value < 0x800:
            total += 2
        elif value < 0x10000:
            total += 3
        else:
            total += 4
    return total


def measure_length(text: str, unit: str) -> int:
    """Length of ``text`` in ``unit``. Raises for a unit this implementation refuses."""
    if unit == "codepoints":
        return code_point_length(text)
    if unit == "utf16":
        return utf16_length(text)
    if unit == "bytes_utf8":
        return utf8_byte_length(text)
    if unit == "graphemes":
        raise ValueError(
            "length_unit 'graphemes' is specified but not supported by this "
            "implementation: Python's unicodedata and the JavaScript runtime's ICU carry "
            "different Unicode versions, so two UAX #29 grapheme breakers would disagree "
            "on the emoji and conjunct sequences the unit exists for. Use 'codepoints', "
            "'utf16' or 'bytes_utf8', which are exact in both"
        )
    raise ValueError(f"{unit!r} is not a spec length unit; expected one of {LENGTH_UNITS}")


def count_lines(text: str) -> int:
    """Line count per spec: empty text has zero lines, one trailing LF adds no line."""
    if text == "":
        return 0
    parts = text.split("\n")
    if len(parts) > 1 and parts[-1] == "":
        parts = parts[:-1]
    return len(parts)


#: Normalisation forms a comparison verifier may declare, per spec section 6.0.
NORMALIZATION_FORMS = ("none", "NFC", "NFD", "NFKC", "NFKD")

#: What a comparison verifier does when it says nothing. NFC rather than none because two
#: answers that a reader cannot tell apart must not score differently: Hangul U+AC00 and
#: the jamo pair U+1100 U+1161 render identically and compare unequal without it.
DEFAULT_NORMALIZATION = "NFC"


def apply_unicode_normalization(text: str, form: str) -> str:
    if form == "none":
        return text
    if form not in ("NFC", "NFD", "NFKC", "NFKD"):
        raise ValueError(f"{form!r} is not a spec unicode normalization form")
    return unicodedata.normalize(form, text)


def is_normalized(text: str, form: str) -> bool:
    return apply_unicode_normalization(text, form) == text


def normalize_json_strings(value: Any, form: str) -> Any:
    """Normalise every string and every object key inside parsed JSON.

    Keys as well as values, because ``{"\\uac00": 1}`` and ``{"\\u1100\\u1161": 1}`` are the
    same object to a reader and different objects to ``required`` and ``properties``.
    """
    if form == "none":
        return value
    if isinstance(value, str):
        return apply_unicode_normalization(value, form)
    if isinstance(value, list):
        return [normalize_json_strings(entry, form) for entry in value]
    if isinstance(value, dict):
        return {
            apply_unicode_normalization(key, form): normalize_json_strings(entry, form)
            for key, entry in value.items()
        }
    return value


_NUMBER_PATTERN = re.compile(
    r"""
    ^
    (?P<sign>[+-])?
    (?:
        (?P<special>nan|inf|infinity)
      |
        (?:
            (?:[0-9]+(?:\.[0-9]*)?)
          | (?:\.[0-9]+)
        )
        (?:[eE][+-]?[0-9]+)?
    )
    $
    """,
    re.VERBOSE | re.IGNORECASE,
)


def parse_spec_number(
    text: str,
    *,
    trim: bool = True,
    allow_thousands_separator: bool = False,
) -> float | None:
    """Parse a candidate under the spec number grammar. ``None`` means not a number."""
    value = text
    if trim:
        value = strip_spec_whitespace(value)
    if allow_thousands_separator:
        value = value.replace(",", "")
    match = _NUMBER_PATTERN.match(value)
    if match is None:
        return None
    special = match.group("special")
    sign = -1.0 if match.group("sign") == "-" else 1.0
    if special is not None:
        if special.lower() == "nan":
            return math.nan
        return sign * math.inf
    return float(value)


def compare_numbers(
    candidate: float,
    expected: float,
    *,
    abs_tol: float = 0.0,
    rel_tol: float = 0.0,
    nan_matches_nan: bool = False,
) -> Verdict:
    """Tolerance comparison with explicit NaN and infinity handling, per spec 6.1."""
    candidate_nan = math.isnan(candidate)
    expected_nan = math.isnan(expected)
    if candidate_nan or expected_nan:
        if candidate_nan and expected_nan and nan_matches_nan:
            return ok("both values are NaN and nan_matches_nan is set")
        return fail(
            "nan_mismatch",
            "NaN was involved and did not satisfy the configured NaN policy",
            candidate="NaN" if candidate_nan else candidate,
            expected="NaN" if expected_nan else expected,
        )
    candidate_inf = math.isinf(candidate)
    expected_inf = math.isinf(expected)
    if candidate_inf or expected_inf:
        if candidate_inf and expected_inf and math.copysign(1.0, candidate) == math.copysign(
            1.0, expected
        ):
            return ok("both values are the same signed infinity")
        return fail(
            "infinity_mismatch",
            "one side is infinite and the other does not match it",
            candidate=_json_number(candidate),
            expected=_json_number(expected),
        )
    tolerance = max(abs_tol, rel_tol * abs(expected))
    difference = abs(candidate - expected)
    if difference <= tolerance:
        return ok()
    return fail(
        "out_of_tolerance",
        f"difference {difference!r} exceeds tolerance {tolerance!r}",
        candidate=candidate,
        expected=expected,
        difference=difference,
        tolerance=tolerance,
    )


def _json_number(value: float) -> Any:
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "Infinity" if value > 0 else "-Infinity"
    return value


def coerce_expected_number(value: Any) -> float:
    """Accept a JSON number, or one of the three non-finite tokens as a string."""
    if isinstance(value, bool):
        raise ValueError("a boolean is not a numeric expectation")
    if isinstance(value, (int, float)):
        return float(value)
    if value == "NaN":
        return math.nan
    if value == "Infinity":
        return math.inf
    if value == "-Infinity":
        return -math.inf
    raise ValueError(f"{value!r} is not a valid numeric expectation")


def deep_equal(left: Any, right: Any) -> bool:
    """Structural equality for parsed JSON.

    ``1`` and ``1.0`` are the same value; ``1`` and ``True`` are not, which plain
    Python ``==`` would get wrong.
    """
    if isinstance(left, bool) or isinstance(right, bool):
        return isinstance(left, bool) and isinstance(right, bool) and left == right
    if left is None or right is None:
        return left is None and right is None
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return float(left) == float(right)
    if isinstance(left, str) and isinstance(right, str):
        return left == right
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(
            deep_equal(a, b) for a, b in zip(left, right)
        )
    if isinstance(left, dict) and isinstance(right, dict):
        if set(left.keys()) != set(right.keys()):
            return False
        return all(deep_equal(left[key], right[key]) for key in left)
    return False
