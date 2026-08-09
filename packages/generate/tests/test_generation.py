# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""Template loading, derivation, rendering and end-to-end generation."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from redrob_generate.canonical import canonical_json, content_hash
from redrob_generate.errors import (
    ExpressionError,
    RenderError,
    SpecError,
    TemplateLoadError,
)
from redrob_generate.expr import evaluate, evaluate_derivations
from redrob_generate.generate import build_instance, build_instances
from redrob_generate.manifest import build_manifest
from redrob_generate.render import render_prompt, resolve_bindings
from redrob_generate.spec import load_template, validate_document

TEMPLATE_DIRS = [
    "math/linear-equation",
    "extraction/quarterly-ledger",
    "format/release-note",
]


@pytest.mark.parametrize("relative", TEMPLATE_DIRS)
def test_shipped_templates_load_and_validate(templates_dir: Path, relative: str) -> None:
    template = load_template(templates_dir / relative)
    validate_document(template, "template")
    assert template["locale"] == "en"


@pytest.mark.parametrize("relative", TEMPLATE_DIRS)
def test_shipped_templates_generate(templates_dir: Path, relative: str) -> None:
    template = load_template(templates_dir / relative)
    instances, records = build_instances(template, 5)
    assert len(instances) == 5
    assert records == []
    for index, instance in enumerate(instances):
        assert instance["instance_index"] == index
        assert instance["prompt"].strip() != ""
        validate_document(instance, "instance")


@pytest.mark.parametrize("relative", TEMPLATE_DIRS)
def test_generation_is_reproducible(templates_dir: Path, relative: str) -> None:
    template = load_template(templates_dir / relative)
    first, _ = build_instances(template, 4)
    second, _ = build_instances(template, 4)
    assert canonical_json(first) == canonical_json(second)


def test_correct_answers_pass_their_own_verifiers(templates_dir: Path) -> None:
    """The self-consistency check: ground truth computed at generation time must verify.

    A template whose own answer fails its own verifier is worse than useless, because it
    reports every model as wrong.
    """
    from redrob_generate.verify import run_verifier

    template = load_template(templates_dir / "extraction/quarterly-ledger")
    instances, _ = build_instances(template, 6)
    for instance in instances:
        verdict = run_verifier(instance["verifier"], instance["derived"]["answer_json"])
        assert verdict.passed, (instance["instance_index"], verdict.code, verdict.message)


def test_math_template_answers_verify(templates_dir: Path) -> None:
    from redrob_generate.verify import run_verifier

    template = load_template(templates_dir / "math/linear-equation")
    instances, _ = build_instances(template, 25)
    for instance in instances:
        answer = instance["derived"]["answer"]
        parameters = instance["parameters"]
        # Recomputed here rather than trusted from the instance, so the test would catch
        # a derivation that silently stopped solving the equation it prints.
        recomputed = (parameters["c"] + parameters["shift"] - parameters["b"]) / parameters["a"]
        assert answer == recomputed
        verdict = run_verifier(instance["verifier"], f"{answer:.4f}")
        assert verdict.passed, (instance["instance_index"], verdict.code)


def test_template_hash_changes_when_the_template_changes(templates_dir: Path) -> None:
    template = load_template(templates_dir / "math/linear-equation")
    original = content_hash(template)
    edited = json.loads(json.dumps(template))
    edited["parameters"][0]["max"] = 13
    assert content_hash(edited) != original


def test_locale_layer_may_not_change_the_task(tmp_path: Path) -> None:
    directory = tmp_path / "family" / "name"
    (directory / "locales").mkdir(parents=True)
    (directory / "template.json").write_text(
        json.dumps(
            {
                "spec_version": "redrob-verifiable-task/v2",
                "id": "t.test",
                "version": "1.0.0",
                "parameters": [{"name": "a", "type": "integer", "min": 1, "max": 2}],
                "verifier": {"type": "exact", "expected": "x"},
            }
        ),
        encoding="utf-8",
    )
    (directory / "locales" / "en.json").write_text(
        json.dumps({"locale": "en", "translation_status": "single-reviewer", "prompt": "{a}"}), encoding="utf-8"
    )
    assert load_template(directory)["prompt"] == "{a}"

    (directory / "locales" / "xx.json").write_text(
        json.dumps(
            {
                "locale": "xx",
                "prompt": "{a}",
                "parameters": [{"name": "a", "type": "integer", "min": 100, "max": 200}],
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(TemplateLoadError, match="only set"):
        load_template(directory, "xx")


def test_missing_locale_is_an_error(templates_dir: Path) -> None:
    with pytest.raises(TemplateLoadError, match="available locales"):
        load_template(templates_dir / "math/linear-equation", "zz")


def test_duplicate_parameter_names_rejected(tmp_path: Path) -> None:
    path = tmp_path / "merged.json"
    path.write_text(
        json.dumps(
            {
                "spec_version": "redrob-verifiable-task/v2",
                "id": "t.test",
                "version": "1.0.0",
                "locale": "en",
                "translation_status": "single-reviewer",
                "parameters": [
                    {"name": "a", "type": "integer", "min": 1, "max": 2},
                    {"name": "a", "type": "integer", "min": 1, "max": 2},
                ],
                "prompt": "{a}",
                "verifier": {"type": "exact", "expected": "x"},
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(SpecError, match="twice"):
        load_template(path)


# ------------------------------------------------------------------ rendering


def test_render_escapes_braces() -> None:
    assert render_prompt("{{literal}} and {a}", {"a": 1}) == "{literal} and 1"


def test_render_rejects_unknown_placeholder() -> None:
    with pytest.raises(RenderError, match="not bound"):
        render_prompt("{missing}", {"a": 1})


def test_render_rejects_unbalanced_brace() -> None:
    with pytest.raises(RenderError):
        render_prompt("a } b", {})


def test_render_formats_values() -> None:
    scope = {"b": True, "i": 3, "f": 2.5, "s": "text", "l": [1, "two"]}
    assert render_prompt("{b} {i} {f} {s} {l}", scope) == "true 3 2.5 text 1, two"


def test_whole_leaf_binding_keeps_the_type() -> None:
    """The reason for two brace syntaxes: this must be a number, not the string "2.5"."""
    resolved = resolve_bindings({"expected": "{{answer}}"}, {"answer": 2.5})
    assert resolved == {"expected": 2.5}
    assert isinstance(resolved["expected"], float)


def test_partial_binding_substitutes_textually() -> None:
    resolved = resolve_bindings({"expected": "v{{n}}"}, {"n": 3})
    assert resolved == {"expected": "v3"}


def test_binding_resolution_reaches_nested_structures() -> None:
    resolved = resolve_bindings(
        {"schema": {"properties": {"a": {"const": "{{value}}"}}}, "list": ["{{value}}"]},
        {"value": 7},
    )
    assert resolved == {"schema": {"properties": {"a": {"const": 7}}}, "list": [7]}


# ---------------------------------------------------------------- derivations


def test_expression_language_basics() -> None:
    scope = {"a": 3, "b": 4, "names": ["x", "y"]}
    assert evaluate("a * b + 1", scope) == 13
    assert evaluate("join('-', names)", scope) == "x-y"
    assert evaluate("[n for n in names if n != 'x']", scope) == ["y"]
    assert evaluate("f'{a}/{b}'", scope) == "3/4"
    assert evaluate("format(a / b, '.3f')", scope) == "0.750"
    assert evaluate("upper('abc')", scope) == "ABC"
    assert evaluate("canonical_json({'b': 1, 'a': 2})", scope) == '{"a":2,"b":1}'


@pytest.mark.parametrize(
    "expression",
    [
        "__import__('os')",
        "open('/etc/passwd')",
        "a.__class__",
        "(lambda: 1)()",
        "[x for x in y for z in y]",
        "eval('1')",
        "exec('1')",
        "globals()",
    ],
)
def test_expression_language_refuses_anything_dangerous(expression: str) -> None:
    with pytest.raises(ExpressionError):
        evaluate(expression, {"a": 1, "y": [1]})


def test_derivations_see_earlier_results() -> None:
    derived = evaluate_derivations(
        [{"name": "b", "expr": "a * 2"}, {"name": "c", "expr": "b + 1"}], {"a": 5}
    )
    assert derived == {"b": 10, "c": 11}


def test_derivation_producing_infinity_fails_early() -> None:
    """Caught here rather than at hashing time, where the message would be useless."""
    with pytest.raises(ExpressionError, match="non-finite"):
        evaluate_derivations([{"name": "x", "expr": "1e308 * 10"}], {})


def test_division_by_zero_is_a_template_error_not_a_crash() -> None:
    with pytest.raises(ExpressionError, match="division by zero"):
        evaluate("1 / 0", {})


# ------------------------------------------------------------------- manifest


def test_manifest_validates_and_carries_a_citation(templates_dir: Path) -> None:
    template = load_template(templates_dir / "math/linear-equation")
    instance, _ = build_instance(template, 0)
    manifest = build_manifest(
        templates=[
            {
                "id": template["id"],
                "version": template["version"],
                "locale": template["locale"],
                "content_hash": instance["template_hash"],
                "instance_count": 1,
            }
        ],
        instance_count=1,
        locale="en",
        created_at="2026-01-01T00:00:00Z",
    )
    validate_document(manifest, "manifest")
    assert manifest["citation"]["doi"] == "TBD"
    assert "@software{redrob_eval" in manifest["citation"]["bibtex"]
    assert manifest["seed_derivation"]["method"] == "sha256-prefix-uint64-be"


def test_manifest_is_identical_apart_from_the_timestamp() -> None:
    first = build_manifest(templates=[], instance_count=0, locale="en", created_at="A")
    second = build_manifest(templates=[], instance_count=0, locale="en", created_at="B")
    first.pop("created_at")
    second.pop("created_at")
    assert canonical_json(first) == canonical_json(second)
