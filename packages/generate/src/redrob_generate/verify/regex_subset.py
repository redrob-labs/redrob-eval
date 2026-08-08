# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""Scanner for the portable regex subset, per spec section 6.1.

Python ``re`` under ``re.ASCII`` is the normative engine. This scanner exists so that
both implementations reject exactly the same patterns, and so that the TypeScript port
has a token stream to rewrite. The Python side only needs the validation half; the
token kinds are still emitted, so the two scanners can be read against each other.
"""

from __future__ import annotations

from dataclasses import dataclass

# Escapes whose meaning is identical in both engines once \s and \S are rewritten.
_CLASS_ESCAPES = set("dDwWsnrtfv0")
_ATOM_ESCAPES = set("dDwWsSbBnrtfv0")
# Rejected outright: backreferences (\1..\9), \A \Z \z \G, \p \P, \k, \N, \c, \L \U \Q \E.
_REJECTED_ESCAPE_LETTERS = set("AZzGpPkNcLUQEB1234567890") - {"0"}
_HEX_DIGITS = set("0123456789abcdefABCDEF")


class RegexSubsetError(ValueError):
    """The pattern is outside the portable subset, or is malformed."""


@dataclass(frozen=True)
class Token:
    kind: str
    text: str


_ATOM_KINDS = {"literal", "dot", "class", "escape", "close"}


def scan(pattern: str) -> list[Token]:
    """Tokenise ``pattern`` or raise :class:`RegexSubsetError`."""
    tokens: list[Token] = []
    index = 0
    length = len(pattern)
    depth = 0

    def previous_kind() -> str | None:
        return tokens[-1].kind if tokens else None

    def require_atom(what: str) -> None:
        kind = previous_kind()
        if kind not in _ATOM_KINDS:
            raise RegexSubsetError(f"quantifier {what!r} does not follow a repeatable atom")

    while index < length:
        char = pattern[index]

        if char == "\\":
            if index + 1 >= length:
                raise RegexSubsetError("pattern ends with a trailing backslash")
            escaped = pattern[index + 1]
            if escaped == "x" or escaped == "u":
                width = 2 if escaped == "x" else 4
                digits = pattern[index + 2 : index + 2 + width]
                if len(digits) != width or any(digit not in _HEX_DIGITS for digit in digits):
                    raise RegexSubsetError(f"malformed \\{escaped} escape")
                tokens.append(Token("literal", pattern[index : index + 2 + width]))
                index += 2 + width
                continue
            if escaped.isalnum():
                if escaped in _REJECTED_ESCAPE_LETTERS:
                    raise RegexSubsetError(
                        f"escape \\{escaped} is outside the portable subset "
                        "(backreferences, \\A \\Z \\z \\G and \\p are not allowed)"
                    )
                if escaped not in _ATOM_ESCAPES:
                    raise RegexSubsetError(f"escape \\{escaped} is not in the portable subset")
                kind = "anchor" if escaped in ("b", "B") else "escape"
                tokens.append(Token(kind, f"\\{escaped}"))
                index += 2
                continue
            tokens.append(Token("literal", f"\\{escaped}"))
            index += 2
            continue

        if char == "[":
            body, consumed = _scan_class(pattern, index)
            tokens.append(Token("class", body))
            index += consumed
            continue

        if char == "]":
            raise RegexSubsetError("unescaped ']' outside a character class")

        if char == "(":
            if pattern.startswith("(?", index):
                marker = pattern[index + 2 : index + 3]
                if marker in (":", "=", "!"):
                    tokens.append(Token("group", pattern[index : index + 3]))
                    index += 3
                    depth += 1
                    continue
                raise RegexSubsetError(
                    f"group '(?{marker}' is outside the portable subset "
                    "(named groups, lookbehind, atomic groups and inline flags are not allowed)"
                )
            tokens.append(Token("group", "("))
            index += 1
            depth += 1
            continue

        if char == ")":
            if depth == 0:
                raise RegexSubsetError("unbalanced ')'")
            depth -= 1
            tokens.append(Token("close", ")"))
            index += 1
            continue

        if char in "*+?":
            require_atom(char)
            text = char
            index += 1
            if index < length and pattern[index] == "?":
                text += "?"
                index += 1
            elif index < length and pattern[index] == "+":
                raise RegexSubsetError("possessive quantifiers are not in the portable subset")
            tokens.append(Token("quantifier", text))
            continue

        if char == "{":
            body, consumed = _scan_brace_quantifier(pattern, index)
            require_atom(body)
            index += consumed
            text = body
            if index < length and pattern[index] == "?":
                text += "?"
                index += 1
            elif index < length and pattern[index] == "+":
                raise RegexSubsetError("possessive quantifiers are not in the portable subset")
            tokens.append(Token("quantifier", text))
            continue

        if char == "}":
            raise RegexSubsetError("unescaped '}' outside a quantifier")

        if char == ".":
            tokens.append(Token("dot", "."))
            index += 1
            continue

        if char == "^":
            tokens.append(Token("caret", "^"))
            index += 1
            continue

        if char == "$":
            tokens.append(Token("dollar", "$"))
            index += 1
            continue

        if char == "|":
            tokens.append(Token("alternation", "|"))
            index += 1
            continue

        tokens.append(Token("literal", char))
        index += 1

    if depth != 0:
        raise RegexSubsetError("unbalanced '('")
    return tokens


def _scan_class(pattern: str, start: int) -> tuple[str, int]:
    index = start + 1
    length = len(pattern)
    if index < length and pattern[index] == "^":
        index += 1
    if index < length and pattern[index] == "]":
        # Python rejects '[]]' and JavaScript reads it as an empty class followed by a
        # literal ']'. Requiring the escape is the only reading both engines share.
        raise RegexSubsetError("']' must be escaped inside a character class")
    while index < length:
        char = pattern[index]
        if char == "\\":
            if index + 1 >= length:
                raise RegexSubsetError("character class ends with a trailing backslash")
            escaped = pattern[index + 1]
            if escaped in ("x", "u"):
                width = 2 if escaped == "x" else 4
                digits = pattern[index + 2 : index + 2 + width]
                if len(digits) != width or any(digit not in _HEX_DIGITS for digit in digits):
                    raise RegexSubsetError(f"malformed \\{escaped} escape in character class")
                index += 2 + width
                continue
            if escaped.isalnum():
                if escaped == "S":
                    raise RegexSubsetError(
                        "\\S inside a character class is outside the portable subset"
                    )
                if escaped not in _CLASS_ESCAPES:
                    raise RegexSubsetError(
                        f"escape \\{escaped} is not allowed inside a character class"
                    )
            index += 2
            continue
        if char == "[":
            raise RegexSubsetError("nested '[' must be escaped inside a character class")
        if char == "]":
            return pattern[start : index + 1], index + 1 - start
        index += 1
    raise RegexSubsetError("unterminated character class")


def _scan_brace_quantifier(pattern: str, start: int) -> tuple[str, int]:
    end = pattern.find("}", start)
    if end == -1:
        raise RegexSubsetError("unescaped '{' that is not a quantifier")
    body = pattern[start + 1 : end]
    parts = body.split(",")
    if len(parts) > 2 or not parts[0].isdigit():
        raise RegexSubsetError("unescaped '{' that is not a quantifier")
    if len(parts) == 2 and parts[1] != "" and not parts[1].isdigit():
        raise RegexSubsetError("unescaped '{' that is not a quantifier")
    if len(parts) == 2 and parts[1].isdigit() and int(parts[1]) < int(parts[0]):
        raise RegexSubsetError("quantifier maximum is below its minimum")
    return pattern[start : end + 1], end + 1 - start


def validate(pattern: str) -> None:
    """Raise :class:`RegexSubsetError` if ``pattern`` is outside the portable subset."""
    scan(pattern)
