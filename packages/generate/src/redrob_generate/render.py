# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""Prompt rendering and verifier binding resolution, per spec section 5.

Two brace syntaxes, deliberately different:

``{name}`` in a prompt interpolates a value into human-readable text.
``{{name}}`` as a whole string leaf of a verifier replaces that leaf with the *typed*
value, so ``"expected": "{{answer}}"`` yields a number rather than the string "2.5".
"""

from __future__ import annotations

import json
import re
from typing import Any, Mapping

from .errors import RenderError

_BINDING = re.compile(r"\{\{([a-z_][a-z0-9_]*)\}\}")


def format_value(value: Any) -> str:
    """Render one value into prompt text."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, str):
        return value
    if isinstance(value, (list, tuple)):
        return ", ".join(format_value(item) for item in value)
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def render_prompt(body: str, scope: Mapping[str, Any]) -> str:
    """Interpolate ``{name}`` placeholders, with ``{{`` and ``}}`` as literal braces."""
    out: list[str] = []
    index = 0
    length = len(body)
    while index < length:
        char = body[index]
        if char == "{":
            if body.startswith("{{", index):
                out.append("{")
                index += 2
                continue
            end = body.find("}", index)
            if end == -1:
                raise RenderError(f"unclosed '{{' at position {index}")
            name = body[index + 1 : end]
            if not re.fullmatch(r"[a-z_][a-z0-9_]*", name):
                raise RenderError(f"{name!r} is not a valid placeholder name")
            if name not in scope:
                raise RenderError(
                    f"placeholder {{{name}}} is not bound by any parameter or derivation"
                )
            out.append(format_value(scope[name]))
            index = end + 1
            continue
        if char == "}":
            if body.startswith("}}", index):
                out.append("}")
                index += 2
                continue
            raise RenderError(f"unescaped '}}' at position {index}; write '}}}}' for a literal")
        out.append(char)
        index += 1
    return "".join(out)


def resolve_bindings(node: Any, scope: Mapping[str, Any]) -> Any:
    """Resolve ``{{name}}`` references anywhere inside a verifier binding."""
    if isinstance(node, dict):
        return {key: resolve_bindings(value, scope) for key, value in node.items()}
    if isinstance(node, list):
        return [resolve_bindings(item, scope) for item in node]
    if not isinstance(node, str):
        return node

    whole = _BINDING.fullmatch(node)
    if whole is not None:
        name = whole.group(1)
        if name not in scope:
            raise RenderError(f"verifier binding {{{{{name}}}}} is not bound")
        return scope[name]

    def substitute(match: re.Match[str]) -> str:
        name = match.group(1)
        if name not in scope:
            raise RenderError(f"verifier binding {{{{{name}}}}} is not bound")
        return format_value(scope[name])

    return _BINDING.sub(substitute, node)
