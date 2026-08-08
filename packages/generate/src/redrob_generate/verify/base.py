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


def count_lines(text: str) -> int:
    """Line count per spec: empty text has zero lines, one trailing LF adds no line."""
    if text == "":
        return 0
    parts = text.split("\n")
    if len(parts) > 1 and parts[-1] == "":
        parts = parts[:-1]
    return len(parts)


def apply_unicode_normalization(text: str, form: str) -> str:
    if form == "none":
        return text
    if form not in ("NFC", "NFD", "NFKC", "NFKD"):
        raise ValueError(f"{form!r} is not a spec unicode normalization form")
    return unicodedata.normalize(form, text)


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
