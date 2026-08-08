# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
r"""Scanner for the portable regex subset, per spec section 6.1.

The subset contains no construct whose meaning depends on which engine reads it. That is
the whole design rule. It is why the shorthand classes, ``.``, ``^``, ``$`` and every
flag are absent from the standalone regex verifier: each of them means something
different in Python ``re`` and in a JavaScript ``RegExp``, and the difference is not
expressible as a flag.

Two premises had to be fixed before the rule was actually true.

The first is the unit of matching. A JavaScript ``RegExp`` without the ``u`` flag matches
UTF-16 code units, so ``[\u0000-\uffff]`` matches the lead surrogate of an astral
character and Python's code-point view does not. The TypeScript side now compiles with
``u``, which puts both engines on code points, and this scanner rejects the two
constructs that ``u`` reinterprets rather than shares: ``\uD800``-``\uDFFF`` escapes,
which ``u`` reads as halves of a surrogate pair, and unpaired surrogate code points in
the pattern source.

The second is case folding. Under ``u`` a JavaScript ``RegExp`` folds with Unicode simple
case folding and Python's ``re.IGNORECASE`` folds with its own table; they agree on the
Kelvin sign, the long s and final sigma, and disagree on U+0130 and U+0131, the Turkish
dotted and dotless I. No pattern-side restriction can exclude those, because they arrive
in the candidate. ``i`` is therefore gone, and case insensitivity is written out as
``[kK]``, which is exact in both engines.

Two dialects exist. ``verifier`` is the standalone regex verifier and has no anchors, the
mode does that job. ``schema_pattern`` is the JSON Schema ``pattern`` keyword, where
``^...$`` is idiomatic and users will reach for it; there ``^`` means start of input and
``$`` means absolute end of input, and :func:`to_python_source` rewrites the one token
``$`` to ``\Z`` because Python's ``$`` also matches before a trailing newline. That single
token is the only translation in the subset, and it is deliberately not a general
rewriter.

Mirrors packages/harness/src/generate/regex-subset.ts.
"""

from __future__ import annotations

from dataclasses import dataclass

#: Escapes for characters that cannot be written literally. Identical in both engines.
#: ``\0`` is absent: Python reads ``\01`` as an octal escape and JavaScript rejects it.
_CHARACTER_ESCAPES = set("nrtfv")
#: Banned with a message of their own, because "not in the subset" is unhelpful when the
#: construct is one every regex author reaches for by reflex.
_SHORTHAND_CLASSES = set("dDwWsSbB")
#: Rejected outright: backreferences (\1..\9), \A \Z \z \G, \p \P, \k, \N, \c, \L \U \Q \E,
#: and \0 for the octal reason above.
_REJECTED_ESCAPE_LETTERS = set("AZzGpPkNcLUQE0123456789")
_HEX_DIGITS = set("0123456789abcdefABCDEF")

#: Punctuation that may be escaped. Exactly the set a JavaScript ``RegExp`` accepts under
#: the ``u`` flag, which Python accepts as well. Escaping anything else is legal in Python
#: and a syntax error under ``u``, so it is not in the subset.
_IDENTITY_ESCAPES = set("^$\\.*+?()[]{}|/")
#: ``-`` is additionally escapable inside a character class, and only there.
_CLASS_IDENTITY_ESCAPES = _IDENTITY_ESCAPES | {"-"}

DIALECTS = ("verifier", "schema_pattern")

#: The standalone regex verifier has no flags at all. Kept as a name so that callers can
#: state the fact rather than hard-code an empty tuple.
SUPPORTED_FLAGS: tuple[str, ...] = ()


class RegexSubsetError(ValueError):
    """The pattern is outside the portable subset, or is malformed."""


@dataclass(frozen=True)
class Token:
    kind: str
    text: str


#: Kinds a quantifier may follow. ``close_assertion`` is deliberately absent: a quantified
#: lookahead is a syntax error under the ``u`` flag and a no-op in Python.
_ATOM_KINDS = {"literal", "class", "escape", "close"}


def _shorthand_error(letter: str) -> RegexSubsetError:
    return RegexSubsetError(
        f"shorthand class \\{letter} is not in the portable subset; write the character "
        "class out, for example [0-9] or [\\u0900-\\u097F]. The shorthand classes are "
        "Unicode-aware in Python and ASCII-only in JavaScript, and the ASCII reading "
        "excludes Devanagari and Hangul"
    )


def _surrogate_escape_error(value: int) -> RegexSubsetError:
    return RegexSubsetError(
        f"\\u{value:04X} is a surrogate code point and is not in the portable subset; "
        "write the character itself. Under the u flag JavaScript reads an adjacent "
        "surrogate pair as one astral code point and Python reads it as two"
    )


def _check_dialect(dialect: str) -> None:
    if dialect not in DIALECTS:
        raise RegexSubsetError(f"{dialect!r} is not a regex dialect; expected one of {DIALECTS}")


def scan(pattern: str, dialect: str = "verifier") -> list[Token]:
    """Tokenise ``pattern`` or raise :class:`RegexSubsetError`.

    The token texts concatenate back to ``pattern`` exactly, which is what makes the one
    permitted rewrite in :func:`to_python_source` checkable.
    """
    _check_dialect(dialect)
    if not isinstance(pattern, str):
        raise RegexSubsetError("a pattern must be a string")

    tokens: list[Token] = []
    index = 0
    length = len(pattern)
    open_groups: list[bool] = []  # True when the group is a lookahead assertion

    def previous_kind() -> str | None:
        return tokens[-1].kind if tokens else None

    def require_atom(what: str) -> None:
        kind = previous_kind()
        if kind == "close_assertion":
            raise RegexSubsetError(
                f"quantifier {what!r} follows a lookahead; a quantified assertion is a "
                "syntax error in JavaScript under the u flag and a no-op in Python"
            )
        if kind not in _ATOM_KINDS:
            raise RegexSubsetError(f"quantifier {what!r} does not follow a repeatable atom")

    while index < length:
        char = pattern[index]

        if "\ud800" <= char <= "\udfff":
            raise RegexSubsetError(
                f"the pattern contains an unpaired surrogate code point U+{ord(char):04X}; "
                "the two engines do not agree on what one matches"
            )

        if char == "\\":
            if index + 1 >= length:
                raise RegexSubsetError("pattern ends with a trailing backslash")
            escaped = pattern[index + 1]
            if escaped in ("x", "u"):
                width = 2 if escaped == "x" else 4
                digits = pattern[index + 2 : index + 2 + width]
                if len(digits) != width or any(digit not in _HEX_DIGITS for digit in digits):
                    raise RegexSubsetError(f"malformed \\{escaped} escape")
                value = int(digits, 16)
                if 0xD800 <= value <= 0xDFFF:
                    raise _surrogate_escape_error(value)
                tokens.append(Token("literal", pattern[index : index + 2 + width]))
                index += 2 + width
                continue
            if escaped.isalnum():
                if escaped in _SHORTHAND_CLASSES:
                    raise _shorthand_error(escaped)
                if escaped in _REJECTED_ESCAPE_LETTERS:
                    raise RegexSubsetError(
                        f"escape \\{escaped} is outside the portable subset "
                        "(backreferences, \\0, \\A \\Z \\z \\G and \\p are not allowed)"
                    )
                if escaped not in _CHARACTER_ESCAPES:
                    raise RegexSubsetError(f"escape \\{escaped} is not in the portable subset")
                tokens.append(Token("escape", f"\\{escaped}"))
                index += 2
                continue
            if escaped not in _IDENTITY_ESCAPES:
                raise RegexSubsetError(
                    f"escape \\{escaped} is not in the portable subset; only "
                    "^ $ \\ . * + ? ( ) [ ] { } | / may be escaped, because a JavaScript "
                    "RegExp under the u flag rejects every other escaped punctuation mark"
                )
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
                    open_groups.append(marker in ("=", "!"))
                    continue
                raise RegexSubsetError(
                    f"group '(?{marker}' is outside the portable subset "
                    "(named groups, lookbehind, atomic groups and inline flags are not allowed)"
                )
            tokens.append(Token("group", "("))
            index += 1
            open_groups.append(False)
            continue

        if char == ")":
            if not open_groups:
                raise RegexSubsetError("unbalanced ')'")
            was_assertion = open_groups.pop()
            tokens.append(Token("close_assertion" if was_assertion else "close", ")"))
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
                "example [^\\n] for any character but a newline. Python excludes only the "
                "newline from '.' while JavaScript also excludes CR, U+2028 and U+2029"
            )

        if char == "^":
            if dialect != "schema_pattern":
                raise RegexSubsetError(
                    "'^' is not in the portable subset for the regex verifier; anchoring is "
                    "the job of 'mode', so use mode 'full_match' rather than an anchor in "
                    "the pattern"
                )
            tokens.append(Token("caret", "^"))
            index += 1
            continue

        if char == "$":
            if dialect != "schema_pattern":
                raise RegexSubsetError(
                    "'$' is not in the portable subset for the regex verifier; use mode "
                    "'full_match' to anchor the end of the candidate. Python's '$' also "
                    "matches before one trailing newline and JavaScript's does not"
                )
            tokens.append(Token("dollar", "$"))
            index += 1
            continue

        if char == "|":
            tokens.append(Token("alternation", "|"))
            index += 1
            continue

        tokens.append(Token("literal", char))
        index += 1

    if open_groups:
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
        if "\ud800" <= char <= "\udfff":
            raise RegexSubsetError(
                f"the character class contains an unpaired surrogate code point "
                f"U+{ord(char):04X}; the two engines do not agree on what one matches"
            )
        if char == "\\":
            if index + 1 >= length:
                raise RegexSubsetError("character class ends with a trailing backslash")
            escaped = pattern[index + 1]
            if escaped in ("x", "u"):
                width = 2 if escaped == "x" else 4
                digits = pattern[index + 2 : index + 2 + width]
                if len(digits) != width or any(digit not in _HEX_DIGITS for digit in digits):
                    raise RegexSubsetError(f"malformed \\{escaped} escape in character class")
                value = int(digits, 16)
                if 0xD800 <= value <= 0xDFFF:
                    raise _surrogate_escape_error(value)
                index += 2 + width
                continue
            if escaped.isalnum():
                if escaped in _SHORTHAND_CLASSES:
                    raise _shorthand_error(escaped)
                if escaped not in _CHARACTER_ESCAPES:
                    raise RegexSubsetError(
                        f"escape \\{escaped} is not allowed inside a character class"
                    )
            elif escaped not in _CLASS_IDENTITY_ESCAPES:
                raise RegexSubsetError(
                    f"escape \\{escaped} is not allowed inside a character class; only "
                    "^ $ \\ . * + ? ( ) [ ] { } | / and - may be escaped there"
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


def validate_flags(flags: object) -> None:
    """Raise unless ``flags`` is empty.

    There is no flag in the subset. ``i`` was the last one and it is gone: see the module
    docstring for the U+0130 and U+0131 divergence that no pattern-side rule can exclude.
    """
    if not isinstance(flags, (list, tuple)):
        raise RegexSubsetError("flags must be a list")
    if flags:
        raise RegexSubsetError(
            f"flag {flags[0]!r} is not in the portable subset; the subset has no flags at "
            "all. Write case insensitivity out as [kK], which folds identically in both "
            "engines, and anchoring as mode 'full_match'"
        )


def validate(pattern: str, flags: object = (), dialect: str = "verifier") -> None:
    """Raise :class:`RegexSubsetError` if ``pattern`` is outside the portable subset."""
    scan(pattern, dialect)
    validate_flags(flags)


def to_python_source(pattern: str, dialect: str = "verifier") -> str:
    r"""The Python ``re`` source for a subset pattern.

    The whole translation is the one line below: the ``$`` token becomes ``\Z``. ``$`` is
    normatively the absolute end of input, which is what JavaScript's ``$`` means without
    the ``m`` flag and what Python's ``\Z`` means; Python's own ``$`` also matches before
    one trailing newline. Every other token is emitted verbatim, and
    ``test_regex_subset.py`` checks that the concatenation of an unrewritten scan is the
    input string, so this cannot quietly become a general rewriter.
    """
    return "".join(
        "\\Z" if token.kind == "dollar" else token.text for token in scan(pattern, dialect)
    )
