# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""The seven declarative verifiers, per spec section 6.1.

These must produce identical verdicts in every implementation of the spec, down to the
verdict code. ``spec/conformance/`` is what proves it; this module is one of the two
things being proved.
"""

from __future__ import annotations

import json
import re
from typing import Any, Mapping

from .base import (
    Verdict,
    apply_unicode_normalization,
    code_point_length,
    coerce_expected_number,
    collapse_spec_whitespace,
    compare_numbers,
    count_lines,
    deep_equal,
    fail,
    normalize_line_endings,
    ok,
    parse_spec_number,
    strip_spec_whitespace,
)
from .json_schema_subset import SchemaSubsetError, validate_schema_document
from .regex_subset import RegexSubsetError, validate as validate_regex_subset


# --------------------------------------------------------------------------- exact


def verify_exact(config: Mapping[str, Any], candidate: str) -> Verdict:
    def normalize(text: str) -> str:
        text = apply_unicode_normalization(text, config.get("unicode_normalization", "none"))
        if config.get("normalize_line_endings", False):
            text = normalize_line_endings(text)
        if config.get("trim", False):
            text = strip_spec_whitespace(text)
        if config.get("collapse_whitespace", False):
            text = collapse_spec_whitespace(text)
        if not config.get("case_sensitive", True):
            text = text.lower()
        return text

    expected = str(config["expected"])
    if normalize(candidate) == normalize(expected):
        return ok()
    return fail("mismatch", "normalised candidate does not equal the normalised expectation")


# --------------------------------------------------------- numeric_tolerance


def verify_numeric_tolerance(config: Mapping[str, Any], candidate: str) -> Verdict:
    parsed = parse_spec_number(
        candidate,
        trim=config.get("trim", True),
        allow_thousands_separator=config.get("allow_thousands_separator", False),
    )
    if parsed is None:
        return fail("not_a_number", "candidate is not a single number under the spec grammar")
    expected = coerce_expected_number(config["expected"])
    return compare_numbers(
        parsed,
        expected,
        abs_tol=float(config.get("abs_tol", 0.0)),
        rel_tol=float(config.get("rel_tol", 0.0)),
        nan_matches_nan=bool(config.get("nan_matches_nan", False)),
    )


# ------------------------------------------------------------------ json_schema


def verify_json_schema(config: Mapping[str, Any], candidate: str) -> Verdict:
    schema = config["schema"]
    # Reject out-of-subset keywords before validating, so that a schema the TypeScript
    # side cannot evaluate fails loudly here instead of passing on one side only.
    try:
        validate_schema_document(schema)
    except SchemaSubsetError as exc:
        raise ValueError(f"schema is outside the supported subset: {exc}") from exc

    try:
        parsed = json.loads(candidate)
    except (ValueError, RecursionError):
        return fail("invalid_json", "candidate is not well-formed JSON")

    import jsonschema  # imported lazily so that a bare import of this package is cheap

    validator_class = jsonschema.validators.validator_for(
        schema if isinstance(schema, dict) else {}, default=jsonschema.Draft202012Validator
    )
    validator = validator_class(schema)
    errors = sorted(validator.iter_errors(parsed), key=lambda error: list(error.absolute_path))
    if not errors:
        return ok()
    first = errors[0]
    pointer = "/" + "/".join(str(part) for part in first.absolute_path)
    return fail(
        "schema_violation",
        f"{pointer}: {first.message}",
        pointer=pointer,
        violations=len(errors),
    )


# ------------------------------------------------------------------------ regex

_PYTHON_FLAGS = {"i": re.IGNORECASE, "m": re.MULTILINE, "s": re.DOTALL}


def verify_regex(config: Mapping[str, Any], candidate: str) -> Verdict:
    pattern = config["pattern"]
    try:
        validate_regex_subset(pattern)
    except RegexSubsetError as exc:
        return fail("invalid_pattern", str(exc))

    # re.ASCII is normative: it makes \d \w \b \s ASCII-only, which is the only reading
    # a JavaScript engine without the u flag can reproduce.
    flags = re.ASCII
    for flag in config.get("flags", []):
        flags |= _PYTHON_FLAGS[flag]
    try:
        compiled = re.compile(pattern, flags)
    except re.error as exc:
        return fail("invalid_pattern", f"pattern did not compile: {exc}")

    mode = config.get("mode", "full_match")
    matched = compiled.fullmatch(candidate) if mode == "full_match" else compiled.search(candidate)
    if matched is not None:
        return ok()
    return fail("no_match", f"pattern did not {mode.replace('_', ' ')} the candidate")


# ------------------------------------------------- set and ordered equality


def _split_elements(config: Mapping[str, Any], candidate: str) -> list[Any] | None:
    parse = config["parse"]
    mode = parse["mode"]
    if mode == "json_array":
        try:
            parsed = json.loads(candidate)
        except (ValueError, RecursionError):
            return None
        if not isinstance(parsed, list):
            return None
        elements: list[Any] = parsed
    elif mode == "lines":
        elements = normalize_line_endings(candidate).split("\n")
    elif mode == "delimiter":
        elements = candidate.split(parse.get("delimiter", ","))
    else:  # pragma: no cover - schema-validated
        raise ValueError(f"unknown parse mode {mode!r}")

    if parse.get("trim_elements", True):
        elements = [
            strip_spec_whitespace(element) if isinstance(element, str) else element
            for element in elements
        ]
    if parse.get("drop_empty", True):
        elements = [element for element in elements if element != ""]
    return elements


def _canonical_key(value: Any, comparator: str) -> Any:
    """A hashable identity used only for deduplication, never for tolerance matching."""
    if comparator == "case_insensitive_string":
        return str(value).lower()
    if comparator == "numeric":
        parsed = parse_spec_number(str(value)) if not isinstance(value, (int, float)) else float(value)
        return ("num", parsed) if parsed is not None else ("raw", str(value))
    if comparator == "json":
        return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return str(value)


def _dedupe(values: list[Any], comparator: str) -> list[Any]:
    seen: list[Any] = []
    result: list[Any] = []
    for value in values:
        key = _canonical_key(value, comparator)
        if key in seen:
            continue
        seen.append(key)
        result.append(value)
    return result


def _elements_equal(
    candidate: Any,
    expected: Any,
    comparator: str,
    abs_tol: float,
    rel_tol: float,
) -> bool:
    if comparator == "exact_string":
        return str(candidate) == str(expected)
    if comparator == "case_insensitive_string":
        return str(candidate).lower() == str(expected).lower()
    if comparator == "json":
        return deep_equal(candidate, expected)
    if comparator == "numeric":
        left = (
            float(candidate)
            if isinstance(candidate, (int, float)) and not isinstance(candidate, bool)
            else parse_spec_number(str(candidate))
        )
        right = (
            float(expected)
            if isinstance(expected, (int, float)) and not isinstance(expected, bool)
            else parse_spec_number(str(expected))
        )
        if left is None or right is None:
            return False
        return compare_numbers(left, right, abs_tol=abs_tol, rel_tol=rel_tol).passed
    raise ValueError(f"unknown element comparator {comparator!r}")  # pragma: no cover


def verify_set_equality(config: Mapping[str, Any], candidate: str) -> Verdict:
    elements = _split_elements(config, candidate)
    if elements is None:
        return fail("parse_error", "candidate could not be split into elements")

    comparator = config.get("element_comparator", "exact_string")
    abs_tol = float(config.get("numeric_abs_tol", 0.0))
    rel_tol = float(config.get("numeric_rel_tol", 0.0))
    expected = list(config["expected"])

    if config.get("duplicates", "collapse") == "collapse":
        elements = _dedupe(elements, comparator)
        expected = _dedupe(expected, comparator)

    if len(elements) != len(expected):
        return fail(
            "cardinality_mismatch",
            f"expected {len(expected)} elements, candidate has {len(elements)}",
            expected_count=len(expected),
            candidate_count=len(elements),
        )

    remaining = list(elements)
    for wanted in expected:
        for index, actual in enumerate(remaining):
            if _elements_equal(actual, wanted, comparator, abs_tol, rel_tol):
                remaining.pop(index)
                break
        else:
            return fail("element_mismatch", f"no candidate element matches {wanted!r}")
    return ok()


def verify_ordered_equality(config: Mapping[str, Any], candidate: str) -> Verdict:
    elements = _split_elements(config, candidate)
    if elements is None:
        return fail("parse_error", "candidate could not be split into elements")

    comparator = config.get("element_comparator", "exact_string")
    abs_tol = float(config.get("numeric_abs_tol", 0.0))
    rel_tol = float(config.get("numeric_rel_tol", 0.0))
    expected = list(config["expected"])

    if len(elements) != len(expected):
        return fail(
            "cardinality_mismatch",
            f"expected {len(expected)} elements, candidate has {len(elements)}",
            expected_count=len(expected),
            candidate_count=len(elements),
        )
    for position, (actual, wanted) in enumerate(zip(elements, expected)):
        if not _elements_equal(actual, wanted, comparator, abs_tol, rel_tol):
            return fail(
                "element_mismatch",
                f"element {position} does not match {wanted!r}",
                position=position,
            )
    return ok()


# ------------------------------------------------------------ format_constraint


def verify_format_constraint(config: Mapping[str, Any], candidate: str) -> Verdict:
    text = candidate
    if config.get("normalize_line_endings", True):
        text = normalize_line_endings(text)
    if config.get("trim", False):
        text = strip_spec_whitespace(text)

    length = code_point_length(text)
    minimum = config.get("min_length")
    maximum = config.get("max_length")
    if minimum is not None and length < minimum:
        return fail(
            "length_out_of_bounds",
            f"length {length} is below the minimum of {minimum}",
            length=length,
        )
    if maximum is not None and length > maximum:
        return fail(
            "length_out_of_bounds",
            f"length {length} exceeds the maximum of {maximum}",
            length=length,
        )

    lines = count_lines(text)
    min_lines = config.get("min_lines")
    max_lines = config.get("max_lines")
    if min_lines is not None and lines < min_lines:
        return fail(
            "line_count_out_of_bounds",
            f"line count {lines} is below the minimum of {min_lines}",
            lines=lines,
        )
    if max_lines is not None and lines > max_lines:
        return fail(
            "line_count_out_of_bounds",
            f"line count {lines} exceeds the maximum of {max_lines}",
            lines=lines,
        )

    case_sensitive = config.get("case_sensitive", True)
    haystack = text if case_sensitive else text.lower()

    for needle in config.get("required_substrings", []):
        probe = needle if case_sensitive else needle.lower()
        if probe not in haystack:
            return fail(
                "missing_required_substring",
                f"required substring {needle!r} is absent",
                substring=needle,
            )
    for needle in config.get("forbidden_substrings", []):
        probe = needle if case_sensitive else needle.lower()
        if probe in haystack:
            return fail(
                "forbidden_substring_present",
                f"forbidden substring {needle!r} is present",
                substring=needle,
            )
    return ok()


# ---------------------------------------------------------------------- all_of

MAX_ALL_OF_DEPTH = 8


def verify_all_of(config: Mapping[str, Any], candidate: str, depth: int = 0) -> Verdict:
    if depth > MAX_ALL_OF_DEPTH:
        raise ValueError(f"all_of nests deeper than {MAX_ALL_OF_DEPTH} levels")
    for child in config["verifiers"]:
        child_type = child.get("type")
        if child_type == "all_of":
            verdict = verify_all_of(child, candidate, depth + 1)
        else:
            handler = DECLARATIVE_VERIFIERS.get(child_type)
            if handler is None:
                # An executable child would be declarative on Python and unsupported on
                # TypeScript, which is exactly the silent divergence all_of must not create.
                raise ValueError(
                    f"all_of child {child_type!r} is not a declarative verifier; "
                    "all_of children must be declarative"
                )
            verdict = handler(child, candidate)
        if not verdict.passed:
            return verdict
    return ok()


DECLARATIVE_VERIFIERS = {
    "exact": verify_exact,
    "numeric_tolerance": verify_numeric_tolerance,
    "json_schema": verify_json_schema,
    "regex": verify_regex,
    "set_equality": verify_set_equality,
    "ordered_equality": verify_ordered_equality,
    "format_constraint": verify_format_constraint,
    "all_of": verify_all_of,
}
