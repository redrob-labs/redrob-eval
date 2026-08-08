# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""Canonical JSON, per spec section 9.1.

Sorted keys, no insignificant whitespace, literal non-ASCII. The interesting part is
numbers: ``repr(1e-9)`` is ``1e-09`` in Python and ``1e-9`` in JavaScript, so a naive
``json.dumps`` produces a hash the TypeScript side cannot reproduce. Rather than banning
such values, this module implements the ECMAScript ``Number::toString`` algorithm, which
makes Python's output identical to ``JSON.stringify``'s for every finite double.
"""

from __future__ import annotations

import hashlib
import math
from json.encoder import encode_basestring  # type: ignore[attr-defined]
from typing import Any

from .errors import CanonicalJsonError

# Beyond 2^53 - 1 an integer is not representable as a double, so the TypeScript reader
# would silently see a different number. Refusing is better than hashing a lie.
MAX_SAFE_INTEGER = (1 << 53) - 1


def js_number_to_string(value: float | int) -> str:
    """Format a number exactly as ECMAScript ``Number::toString`` would.

    Python's ``repr`` switches to exponent notation at 1e16 and 1e-5; ECMAScript switches
    at 1e21 and 1e-7, and writes the exponent without a leading zero. Both produce the
    same shortest round-trip digits, so only the presentation has to be redone.
    """
    if isinstance(value, int) and not isinstance(value, bool):
        if abs(value) > MAX_SAFE_INTEGER:
            raise CanonicalJsonError(
                f"integer {value} exceeds the safe double range and would not survive "
                "a round trip through a JavaScript reader"
            )
        return str(value)

    number = float(value)
    if math.isnan(number) or math.isinf(number):
        raise CanonicalJsonError(f"non-finite number cannot be canonicalised: {number!r}")
    if number == 0.0:
        return "0"

    negative = number < 0
    magnitude = abs(number)

    if magnitude.is_integer() and magnitude < 1e21:
        text = str(int(magnitude))
    else:
        digits, exponent = _shortest_digits(magnitude)
        text = _ecmascript_format(digits, exponent)
    return f"-{text}" if negative else text


def _shortest_digits(magnitude: float) -> tuple[str, int]:
    """Return ``(digits, n)`` where the value is ``0.digits * 10**n``."""
    representation = repr(magnitude)
    if "e" in representation or "E" in representation:
        mantissa, _, exponent_text = representation.replace("E", "e").partition("e")
        exponent = int(exponent_text)
    else:
        mantissa, exponent = representation, 0
    integer_part, _, fraction_part = mantissa.partition(".")
    raw = integer_part + fraction_part
    stripped = raw.lstrip("0")
    leading_zeros = len(raw) - len(stripped)
    point = len(integer_part) + exponent - leading_zeros
    digits = stripped.rstrip("0") or "0"
    return digits, point


def _ecmascript_format(digits: str, point: int) -> str:
    """The presentation half of ECMAScript's Number::toString, spelled out."""
    count = len(digits)
    if count <= point <= 21:
        return digits + "0" * (point - count)
    if 0 < point <= 21:
        return digits[:point] + "." + digits[point:]
    if -6 < point <= 0:
        return "0." + "0" * (-point) + digits
    exponent = point - 1
    sign = "+" if exponent >= 0 else "-"
    body = digits if count == 1 else digits[0] + "." + digits[1:]
    return f"{body}e{sign}{abs(exponent)}"


def _serialise(value: Any, path: str, out: list[str]) -> None:
    if value is None:
        out.append("null")
        return
    if isinstance(value, bool):
        out.append("true" if value else "false")
        return
    if isinstance(value, (int, float)):
        try:
            out.append(js_number_to_string(value))
        except CanonicalJsonError as exc:
            raise CanonicalJsonError(f"{path}: {exc}") from exc
        return
    if isinstance(value, str):
        out.append(encode_basestring(value))
        return
    if isinstance(value, (list, tuple)):
        out.append("[")
        for index, item in enumerate(value):
            if index:
                out.append(",")
            _serialise(item, f"{path}[{index}]", out)
        out.append("]")
        return
    if isinstance(value, dict):
        keys = []
        for key in value:
            if not isinstance(key, str):
                raise CanonicalJsonError(f"{path}: object key {key!r} is not a string")
            keys.append(key)
        out.append("{")
        # Sorted by code point, which is what Python's str comparison already does and
        # what a JavaScript implementation gets from Array.prototype.sort's default.
        for index, key in enumerate(sorted(keys)):
            if index:
                out.append(",")
            out.append(encode_basestring(key))
            out.append(":")
            _serialise(value[key], f"{path}.{key}", out)
        out.append("}")
        return
    raise CanonicalJsonError(f"{path}: value of type {type(value).__name__} is not JSON")


def canonical_json(value: Any) -> str:
    """Serialise ``value`` to the canonical form defined by the spec."""
    out: list[str] = []
    _serialise(value, "$", out)
    return "".join(out)


def content_hash(value: Any) -> str:
    """``sha256:`` plus the lowercase hex digest of the canonical JSON of ``value``."""
    digest = hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


def write_canonical_json(path: Any, value: Any) -> None:
    """Write ``value`` as canonical JSON with LF endings and one trailing newline."""
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(canonical_json(value) + "\n")
