# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""Scanner for the portable regex subset, per spec section 6.1.

The subset contains no construct whose meaning depends on which engine reads it. That is
the whole design rule, and it is why the shorthand classes, ``.`` and ``$`` are absent:
each of them means something different in Python ``re`` and in a JavaScript ``RegExp``,
and the difference is not expressible as a flag.

The shorthand classes are the important case for this project. ``\\w``, ``\\d`` and
``\\b`` are Unicode-aware in Python and ASCII-only in a JavaScript ``RegExp`` without the
``u`` flag. Either reading is defensible; neither is portable. Forcing them to agree meant
pinning ASCII semantics, and ASCII semantics say that Devanagari and Hangul contain no
word characters and no digits, which is wrong for a benchmark whose targets are Hindi,
Hinglish and Korean. An explicit ``[\\u0900-\\u097F]`` says what it means in both engines
and in the reader's head.

Because nothing here is dialect-dependent, both implementations compile the pattern
verbatim. There is no translation layer, and so no place for a translation bug.

Mirrors packages/harness/src/generate/regex-subset.ts.
"""

from __future__ import annotations

from dataclasses import dataclass

# Escapes for characters that cannot be written literally. Identical in both engines.
_CHARACTER_ESCAPES = set("nrtfv0")
# Banned with a message of their own, because "not in the subset" is unhelpful when the
# construct is one every regex author reaches for by reflex.
_SHORTHAND_CLASSES = set("dDwWsSbB")
# Rejected outright: backreferences (\1..\9), \A \Z \z \G, \p \P, \k, \N, \c, \L \U \Q \E.
_REJECTED_ESCAPE_LETTERS = set("AZzGpPkNcLUQE123456789")
_HEX_DIGITS = set("0123456789abcdefABCDEF")

#: The only flag in the subset. See :func:`validate_flags` for the condition on it.
SUPPORTED_FLAGS = ("i",)


class RegexSubsetError(ValueError):
    """The pattern is outside the portable subset, or is malformed."""


@dataclass(frozen=True)
class Token:
    kind: str
    text: str


_ATOM_KINDS = {"literal", "class", "escape", "close"}


def _shorthand_error(letter: str) -> RegexSubsetError:
    return RegexSubsetError(
        f"shorthand class \\{letter} is not in the portable subset; write the character "
        "class out, for example [0-9] or [\\u0900-\\u097F]. The shorthand classes are "
        "Unicode-aware in Python and ASCII-only in JavaScript, and the ASCII reading "
        "excludes Devanagari and Hangul"
    )


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
            if escaped in ("x", "u"):
                width = 2 if escaped == "x" else 4
                digits = pattern[index + 2 : index + 2 + width]
                if len(digits) != width or any(digit not in _HEX_DIGITS for digit in digits):
                    raise RegexSubsetError(f"malformed \\{escaped} escape")
                tokens.append(Token("literal", pattern[index : index + 2 + width]))
                index += 2 + width
                continue
            if escaped.isalnum():
                if escaped in _SHORTHAND_CLASSES:
                    raise _shorthand_error(escaped)
                if escaped in _REJECTED_ESCAPE_LETTERS:
                    raise RegexSubsetError(
                        f"escape \\{escaped} is outside the portable subset "
                        "(backreferences, \\A \\Z \\z \\G and \\p are not allowed)"
                    )
                if escaped not in _CHARACTER_ESCAPES:
                    raise RegexSubsetError(f"escape \\{escaped} is not in the portable subset")
                tokens.append(Token("escape", f"\\{escaped}"))
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
            raise RegexSubsetError(
                "'.' is not in the portable subset; write the character class out, for "
                "example [^\\n] for any character but a newline or [\\u0000-\\uffff] for "
                "any character. Python excludes only the newline from '.' while "
                "JavaScript also excludes CR, U+2028 and U+2029"
            )

        if char == "^":
            tokens.append(Token("caret", "^"))
            index += 1
            continue

        if char == "$":
            raise RegexSubsetError(
                "'$' is not in the portable subset; use mode 'full_match' to anchor the "
                "end of the candidate. Python's '$' also matches before one trailing "
                "newline and JavaScript's does not"
            )

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
                if escaped in _SHORTHAND_CLASSES:
                    raise _shorthand_error(escaped)
                if escaped not in _CHARACTER_ESCAPES:
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


def validate_flags(pattern: str, flags: object) -> None:
    """Raise unless every flag is in the subset and permitted for this pattern.

    ``i`` is confined to ASCII-only patterns. Case folding is the one remaining place the
    two engines disagree: a JavaScript ``RegExp`` without the ``u`` flag folds Greek and
    Cyrillic but refuses to fold a non-ASCII character down to an ASCII one, while Python
    under ``re.ASCII`` folds nothing outside ASCII at all. Restricted to an ASCII pattern
    the two coincide exactly, and outside it they cannot be made to without a translator.

    Nothing is lost for this project's targets, since Devanagari and Hangul are caseless.
    """
    if not isinstance(flags, (list, tuple)):
        raise RegexSubsetError("flags must be a list")
    for flag in flags:
        if flag not in SUPPORTED_FLAGS:
            raise RegexSubsetError(
                f"flag {flag!r} is not in the portable subset; the subset has no 'm' or "
                "'s' because it has no '$' or '.' for them to modify"
            )
    if "i" in flags and not pattern.isascii():
        raise RegexSubsetError(
            "flag 'i' is only permitted on an ASCII-only pattern, because the two engines "
            "fold non-ASCII case differently; write the alternatives out explicitly"
        )


def validate(pattern: str, flags: object = ()) -> None:
    """Raise :class:`RegexSubsetError` if ``pattern`` is outside the portable subset."""
    scan(pattern)
    validate_flags(pattern, flags)
