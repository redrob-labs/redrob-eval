# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""Keyword allowlist for the ``json_schema`` verifier, per spec section 6.1.

Python validates with the full ``jsonschema`` library and TypeScript carries no JSON
Schema dependency at all, so the two only agree over a restricted keyword set. This
module enforces that restriction on the Python side. A schema outside the subset is a
configuration error and is rejected, rather than validated here and skipped there.
"""

from __future__ import annotations

from typing import Any

from .regex_subset import RegexSubsetError, validate as validate_regex_subset

SUPPORTED_KEYWORDS = frozenset(
    {
        "$comment",
        "$defs",
        "$ref",
        "$schema",
        "additionalProperties",
        "allOf",
        "anyOf",
        "const",
        "contains",
        "default",
        "dependentRequired",
        "deprecated",
        "description",
        "enum",
        "examples",
        "exclusiveMaximum",
        "exclusiveMinimum",
        "items",
        "maxContains",
        "maxItems",
        "maxLength",
        "maxProperties",
        "maximum",
        "minContains",
        "minItems",
        "minLength",
        "minProperties",
        "minimum",
        "multipleOf",
        "not",
        "oneOf",
        "pattern",
        "patternProperties",
        "prefixItems",
        "properties",
        "propertyNames",
        "readOnly",
        "required",
        "title",
        "type",
        "uniqueItems",
        "writeOnly",
    }
)

# Rejected with a reason, rather than silently ignored, because ignoring an assertion
# keyword turns a failing candidate into a passing one.
REJECTED_KEYWORDS = frozenset(
    {
        "$anchor",
        "$dynamicAnchor",
        "$dynamicRef",
        "$id",
        "$vocabulary",
        "contentEncoding",
        "contentMediaType",
        "contentSchema",
        "dependencies",
        "dependentSchemas",
        "else",
        "format",
        "if",
        "then",
        "unevaluatedItems",
        "unevaluatedProperties",
    }
)

VALID_TYPES = frozenset({"null", "boolean", "object", "array", "number", "string", "integer"})

_SUBSCHEMA_KEYWORDS = ("not", "contains", "propertyNames", "items", "additionalProperties")
_SUBSCHEMA_LIST_KEYWORDS = ("allOf", "anyOf", "oneOf", "prefixItems")
_SUBSCHEMA_MAP_KEYWORDS = ("properties", "patternProperties", "$defs")

MAX_DEPTH = 64


class SchemaSubsetError(ValueError):
    """A schema uses a keyword or construct outside the supported subset."""


def validate_schema_document(schema: Any, path: str = "#", depth: int = 0) -> None:
    """Walk ``schema`` and raise :class:`SchemaSubsetError` on anything unsupported."""
    if isinstance(schema, bool):
        return
    if not isinstance(schema, dict):
        raise SchemaSubsetError(f"{path}: a schema must be an object or a boolean")
    if depth > MAX_DEPTH:
        raise SchemaSubsetError(f"{path}: schema nests deeper than {MAX_DEPTH} levels")

    for keyword in schema:
        if keyword in REJECTED_KEYWORDS:
            raise SchemaSubsetError(f"{path}: keyword {keyword!r} is outside the supported subset")
        if keyword not in SUPPORTED_KEYWORDS:
            raise SchemaSubsetError(f"{path}: keyword {keyword!r} is not recognised")

    reference = schema.get("$ref")
    if reference is not None:
        if not isinstance(reference, str) or not reference.startswith("#/$defs/"):
            raise SchemaSubsetError(
                f"{path}: only local '#/$defs/...' references are supported, got {reference!r}"
            )

    declared = schema.get("type")
    if declared is not None:
        names = declared if isinstance(declared, list) else [declared]
        for name in names:
            if name not in VALID_TYPES:
                raise SchemaSubsetError(f"{path}: {name!r} is not a JSON Schema type")

    for keyword in ("pattern",):
        value = schema.get(keyword)
        if isinstance(value, str):
            try:
                validate_regex_subset(value)
            except RegexSubsetError as exc:
                raise SchemaSubsetError(f"{path}/{keyword}: {exc}") from exc

    for keyword in _SUBSCHEMA_KEYWORDS:
        if keyword in schema:
            validate_schema_document(schema[keyword], f"{path}/{keyword}", depth + 1)

    for keyword in _SUBSCHEMA_LIST_KEYWORDS:
        if keyword in schema:
            entries = schema[keyword]
            if not isinstance(entries, list):
                raise SchemaSubsetError(f"{path}/{keyword}: expected an array of schemas")
            for index, entry in enumerate(entries):
                validate_schema_document(entry, f"{path}/{keyword}/{index}", depth + 1)

    for keyword in _SUBSCHEMA_MAP_KEYWORDS:
        if keyword in schema:
            entries = schema[keyword]
            if not isinstance(entries, dict):
                raise SchemaSubsetError(f"{path}/{keyword}: expected an object of schemas")
            for name, entry in entries.items():
                if keyword == "patternProperties":
                    try:
                        validate_regex_subset(name)
                    except RegexSubsetError as exc:
                        raise SchemaSubsetError(f"{path}/{keyword}/{name}: {exc}") from exc
                validate_schema_document(entry, f"{path}/{keyword}/{name}", depth + 1)
