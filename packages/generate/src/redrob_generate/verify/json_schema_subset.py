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

from .base import DEFAULT_NORMALIZATION, is_normalized
from .regex_subset import RegexSubsetError, scan as scan_regex_subset

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


def validate_schema_document(
    schema: Any,
    path: str = "#",
    depth: int = 0,
    *,
    normalization: str = DEFAULT_NORMALIZATION,
) -> None:
    """Walk ``schema`` and raise :class:`SchemaSubsetError` on anything unsupported.

    ``normalization`` is the form the verifier will apply to the candidate document. The
    schema is not rewritten to match it; it is required to be in that form already and
    rejected otherwise. Normalising a candidate while comparing it against an
    unnormalised ``const`` would silently never match, and the author would have no way
    to see why, so the mismatch is reported at configuration time instead.
    """
    if isinstance(schema, bool):
        return
    if not isinstance(schema, dict):
        raise SchemaSubsetError(f"{path}: a schema must be an object or a boolean")
    if depth > MAX_DEPTH:
        raise SchemaSubsetError(f"{path}: schema nests deeper than {MAX_DEPTH} levels")
    _require_normalized(schema, path, normalization)

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
                scan_regex_subset(value, "schema_pattern")
            except RegexSubsetError as exc:
                raise SchemaSubsetError(f"{path}/{keyword}: {exc}") from exc

    for keyword in _SUBSCHEMA_KEYWORDS:
        if keyword in schema:
            validate_schema_document(
                schema[keyword], f"{path}/{keyword}", depth + 1, normalization=normalization
            )

    for keyword in _SUBSCHEMA_LIST_KEYWORDS:
        if keyword in schema:
            entries = schema[keyword]
            if not isinstance(entries, list):
                raise SchemaSubsetError(f"{path}/{keyword}: expected an array of schemas")
            for index, entry in enumerate(entries):
                validate_schema_document(
                    entry, f"{path}/{keyword}/{index}", depth + 1, normalization=normalization
                )

    for keyword in _SUBSCHEMA_MAP_KEYWORDS:
        if keyword in schema:
            entries = schema[keyword]
            if not isinstance(entries, dict):
                raise SchemaSubsetError(f"{path}/{keyword}: expected an object of schemas")
            for name, entry in entries.items():
                if keyword == "patternProperties":
                    try:
                        scan_regex_subset(name, "schema_pattern")
                    except RegexSubsetError as exc:
                        raise SchemaSubsetError(f"{path}/{keyword}/{name}: {exc}") from exc
                validate_schema_document(
                    entry, f"{path}/{keyword}/{name}", depth + 1, normalization=normalization
                )


#: Keywords whose string content is a regex or a subschema, and so is not text that will
#: be compared against a normalised candidate. Normalising a pattern would rewrite the
#: pattern; subschemas are reached by the recursion instead.
_NOT_COMPARED_TEXT = (
    frozenset({"pattern", "patternProperties"})
    | frozenset(_SUBSCHEMA_KEYWORDS)
    | frozenset(_SUBSCHEMA_LIST_KEYWORDS)
    | frozenset(_SUBSCHEMA_MAP_KEYWORDS)
)


def _require_normalized(schema: dict, path: str, form: str) -> None:
    """Refuse a schema whose own strings are not already in the declared form.

    Only this level: subschemas are checked when the walk reaches them, and the property
    names inside ``properties`` and ``$defs`` are checked here because the walk descends
    into their values without looking at their keys.
    """
    if form == "none":
        return

    def check(text: str, where: str) -> None:
        if not is_normalized(text, form):
            raise SchemaSubsetError(
                f"{where}: the string {text!r} is not in {form}, and the candidate is "
                f"normalised to {form} before comparison, so it could never match. Write "
                "the schema in the declared form, or declare normalization 'none'"
            )

    for keyword, value in schema.items():
        if keyword in ("properties", "$defs"):
            if isinstance(value, dict):
                for name in value:
                    check(name, f"{path}/{keyword}")
            continue
        if keyword in _NOT_COMPARED_TEXT:
            continue
        for text in _strings_in(value):
            check(text, f"{path}/{keyword}")


def _strings_in(value: Any) -> Any:
    """Yield every string reachable from ``value``, keys included."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for entry in value:
            yield from _strings_in(entry)
    elif isinstance(value, dict):
        for key, entry in value.items():
            yield key
            yield from _strings_in(entry)
