# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""Study runner behaviour.

The end-to-end tests run against the mock provider, which reaches no network and costs
nothing. The aggregation tests build their rows by hand rather than by running a study,
because the shipped example produces a token delta of exactly zero in every comparison
-- correctly, since the stub locales are the English text verbatim -- and a delta test
whose expected answer is zero cannot tell a working subtraction from one that returns a
constant.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from redrob_generate.errors import SpecError
from redrob_generate.provenance import UNICODE_VERSION, is_authoritative, local_provenance
from redrob_generate.spec import load_template
from redrob_generate.study.config import load_study_config
from redrob_generate.study.models import MockModelClient, WRONG_ANSWER, synthesize_passing_answer
from redrob_generate.study.publish import PublicationRefused, assert_publishable
from redrob_generate.study.result import build_result, paired_deltas, token_rows
from redrob_generate.study.runner import Scored, run_study, verifier_family
from redrob_generate.study.table import render_table
from redrob_generate.study.tokenizers import UnknownTokenizerError, resolve_tokenizer

REPO_ROOT = Path(__file__).resolve().parents[3]
EXAMPLE_CONFIG = REPO_ROOT / "packages" / "generate" / "examples" / "language-cost-mock.study.json"
TEMPLATE_DIRS = sorted((REPO_ROOT / "templates").glob("*/*/template.json"))
STUB_LOCALES = ("hi", "hi-Latn", "ko")


# ------------------------------------------------------------------ locale layer


@pytest.mark.parametrize("core", TEMPLATE_DIRS, ids=lambda path: path.parent.name)
def test_every_template_has_all_four_study_locales(core: Path) -> None:
    available = sorted(path.stem for path in (core.parent / "locales").glob("*.json"))
    assert available == ["en", "hi", "hi-Latn", "ko"]


@pytest.mark.parametrize("core", TEMPLATE_DIRS, ids=lambda path: path.parent.name)
def test_a_stub_locale_is_the_english_text_verbatim(core: Path) -> None:
    """The property that makes a stub honest.

    A stub exists to exercise the pipeline, and it can only do that without lying if it
    is a copy. If someone hand-edited one -- a stray space, a reflowed line -- the
    per-locale token counts would start differing, and the difference would look like a
    finding about the language rather than an accident in a placeholder file.
    """
    english = load_template(core.parent, "en")
    for tag in STUB_LOCALES:
        stub = load_template(core.parent, tag)
        assert stub["prompt"] == english["prompt"], f"{core.parent.name}/{tag} drifted"
        assert stub["translation_status"] == "untranslated"


@pytest.mark.parametrize("core", TEMPLATE_DIRS, ids=lambda path: path.parent.name)
def test_a_locale_layer_cannot_smuggle_in_a_review_it_did_not_have(core: Path) -> None:
    for tag in ("en", *STUB_LOCALES):
        template = load_template(core.parent, tag)
        assert template["translation_status"] in (
            "native-reviewed",
            "single-reviewer",
            "untranslated",
        )


def test_a_locale_layer_without_translation_status_is_refused(tmp_path: Path) -> None:
    directory = tmp_path / "family"
    (directory / "locales").mkdir(parents=True)
    (directory / "template.json").write_text(
        json.dumps(
            {
                "spec_version": "redrob-verifiable-task/v2",
                "id": "t.status",
                "version": "1.0.0",
                "parameters": [{"name": "a", "type": "integer", "min": 1, "max": 2}],
                "verifier": {"type": "exact", "expected": "1"},
            }
        ),
        encoding="utf-8",
    )
    (directory / "locales" / "en.json").write_text(
        json.dumps({"locale": "en", "prompt": "{a}"}), encoding="utf-8"
    )
    with pytest.raises(Exception, match="translation_status"):
        load_template(directory)


# ---------------------------------------------------------------------- the mock


def test_the_mock_never_assumes_its_own_answer_is_right() -> None:
    """A synthesised answer is scored, not trusted.

    The mock guesses from the verifier config; the runner then runs the real verifier
    over that guess. If the mock's guess were taken as a pass, a broken verifier would
    show 100% accuracy and look like a working study.
    """
    verifier = {"type": "exact", "expected": "42", "normalization": "NFC"}
    assert synthesize_passing_answer(verifier, {}) == "42"


def test_the_mock_declines_verifiers_it_cannot_invert() -> None:
    for verifier in (
        {"type": "format_constraint", "min_length": 3},
        {"type": "regex", "pattern": "abc", "mode": "full_match"},
        {"type": "json_schema", "schema": {"type": "object"}},
    ):
        assert synthesize_passing_answer(verifier, {}) is None


def test_the_wrong_strategy_answers_wrongly_and_says_so() -> None:
    client = MockModelClient("wrong")
    response = client.complete(
        model_id="m",
        prompt="p",
        instance={"verifier": {"type": "exact", "expected": "42"}, "template_id": "t"},
    )
    assert response.text == WRONG_ANSWER
    assert response.provider == "mock"


def test_the_mock_is_deterministic() -> None:
    instance = {
        "verifier": {"type": "exact", "expected": "42"},
        "template_id": "t",
        "instance_index": 3,
    }
    first = MockModelClient("alternating").complete(model_id="m", prompt="p", instance=instance)
    second = MockModelClient("alternating").complete(model_id="m", prompt="p", instance=instance)
    assert first.text == second.text


# --------------------------------------------------------------------- provenance


def test_a_python_verdict_is_authoritative_and_names_its_unicode_table() -> None:
    provenance = local_provenance()
    assert provenance["implementation"] == "redrob-generate"
    assert provenance["authoritative"] is True
    assert provenance["unicode_version"] == UNICODE_VERSION
    assert provenance["unicode_version"].split(".")[0].isdigit()


def test_missing_provenance_is_not_authoritative() -> None:
    """Absence has to fail closed: unknown origin is exactly the case to refuse."""
    assert is_authoritative(None) is False
    assert is_authoritative({}) is False
    assert is_authoritative({"authoritative": "yes"}) is False
    assert is_authoritative({"authoritative": True}) is True


# ------------------------------------------------------------------- aggregation


def _row(locale: str, index: int, tokens: int, passed: bool, model: str = "m") -> Scored:
    return Scored(
        model_id=model,
        template_id="t.one",
        locale=locale,
        instance_index=index,
        seed=str(1000 + index),
        verifier_family="exact",
        passed=passed,
        code="ok" if passed else "mismatch",
        elements=None,
        prompt_tokens=tokens,
        code_mix_ratio=None,
    )


def test_a_paired_delta_is_the_mean_of_per_pair_differences() -> None:
    scored = [
        _row("en", 0, 100, True),
        _row("en", 1, 200, False),
        _row("ko", 0, 130, True),
        _row("ko", 1, 260, True),
    ]
    [delta] = paired_deltas(scored, [{"id": "c", "left": "en", "right": "ko"}])
    assert delta["n_pairs"] == 2
    assert delta["dropped_unpaired"] == 0
    assert delta["mean_prompt_tokens_left"] == 150.0
    assert delta["mean_prompt_tokens_right"] == 195.0
    # (130-100) and (260-200) average to 45, which is also 195-150 for a complete pairing.
    assert delta["mean_prompt_tokens_delta"] == 45.0
    assert delta["accuracy_left"] == 0.5
    assert delta["accuracy_right"] == 1.0
    assert delta["accuracy_delta"] == 0.5


def test_an_unpaired_item_is_dropped_and_counted_rather_than_filled_in() -> None:
    scored = [_row("en", 0, 100, True), _row("en", 1, 200, True), _row("ko", 0, 150, True)]
    [delta] = paired_deltas(scored, [{"id": "c", "left": "en", "right": "ko"}])
    assert delta["n_pairs"] == 1
    assert delta["dropped_unpaired"] == 1
    # 200 is absent from the right side, so it must not reach the left mean either;
    # otherwise the delta compares two different sets of items.
    assert delta["mean_prompt_tokens_left"] == 100.0
    assert delta["mean_prompt_tokens_delta"] == 50.0


def test_token_means_count_a_prompt_once_however_many_models_saw_it() -> None:
    scored = [_row("en", 0, 100, True, model="a"), _row("en", 0, 100, True, model="b")]
    [row] = token_rows(scored)
    assert row["n"] == 1
    assert row["mean_prompt_tokens"] == 100.0


def test_a_verifier_list_is_named_by_its_elements() -> None:
    assert verifier_family([{"type": "json_schema"}, {"type": "exact"}]) == "[json_schema, exact]"
    assert verifier_family({"type": "exact"}) == "exact"


# ------------------------------------------------------------------------- config


def test_the_example_config_loads() -> None:
    config = load_study_config(EXAMPLE_CONFIG)
    assert config.id == "language-cost-mock"
    assert [c["id"] for c in config.comparisons] == [
        "english-vs-korean",
        "korean-vs-hindi",
        "hindi-vs-hinglish",
    ]


def test_a_comparison_naming_an_undeclared_locale_is_refused(tmp_path: Path) -> None:
    document = json.loads(EXAMPLE_CONFIG.read_text(encoding="utf-8"))
    document["comparisons"].append({"id": "bad", "left": "en", "right": "ja"})
    path = tmp_path / "study.json"
    path.write_text(json.dumps(document), encoding="utf-8")
    with pytest.raises(SpecError, match="which the study does not declare"):
        load_study_config(path)


def test_a_config_from_another_generator_version_is_refused(tmp_path: Path) -> None:
    """Seeds derive from the generator version, so the items would not be these items."""
    document = json.loads(EXAMPLE_CONFIG.read_text(encoding="utf-8"))
    document["seed_policy"]["generator_version"] = "9.9.9"
    path = tmp_path / "study.json"
    path.write_text(json.dumps(document), encoding="utf-8")
    with pytest.raises(SpecError, match="seeds derive from the generator version"):
        load_study_config(path)


def test_an_unknown_tokenizer_is_refused_rather_than_approximated() -> None:
    with pytest.raises(UnknownTokenizerError, match="available schemes"):
        resolve_tokenizer("gpt-4o", "1")


def test_a_tokenizer_version_mismatch_is_refused() -> None:
    with pytest.raises(UnknownTokenizerError, match="only comparable within one version"):
        resolve_tokenizer("builtin/utf8-bytes", "2")


# -------------------------------------------------------------------- publication


def _mock_result(tmp_path: Path) -> dict:
    config = load_study_config(EXAMPLE_CONFIG)
    tokenizer = resolve_tokenizer(config.tokenizer["name"], config.tokenizer["version"])
    scored, locales = run_study(config, tokenizer)
    return build_result(config, scored, locales, created_at="2026-01-01T00:00:00Z")


def test_publication_refuses_an_untranslated_locale(tmp_path: Path) -> None:
    result = _mock_result(tmp_path)
    with pytest.raises(PublicationRefused, match="untranslated"):
        assert_publishable(result)


def test_publication_accepts_the_same_artifact_once_its_locales_are_reviewed(
    tmp_path: Path,
) -> None:
    """The counterpart to the refusal.

    Without this, the refusal test would also pass if `assert_publishable` refused
    everything unconditionally, which is a gate that blocks publishing rather than one
    that checks it.
    """
    result = _mock_result(tmp_path)
    for locale in result["locales"]:
        locale["translation_status"] = "native-reviewed"
    assert_publishable(result)


def test_publication_refuses_a_typescript_produced_verdict(tmp_path: Path) -> None:
    result = _mock_result(tmp_path)
    for locale in result["locales"]:
        locale["translation_status"] = "native-reviewed"
    result["instances"][0]["verdict_provenance"] = {
        "implementation": "@redrob/harness",
        "implementation_version": "22.14.0",
        "unicode_version": "16.0",
        "authoritative": False,
    }
    with pytest.raises(PublicationRefused, match="@redrob/harness"):
        assert_publishable(result)


def test_publication_refuses_a_verdict_with_no_provenance_at_all(tmp_path: Path) -> None:
    result = _mock_result(tmp_path)
    for locale in result["locales"]:
        locale["translation_status"] = "native-reviewed"
    del result["instances"][0]["verdict_provenance"]
    with pytest.raises(PublicationRefused, match="missing provenance"):
        assert_publishable(result)


# ---------------------------------------------------------------------- artifact


def test_every_instance_row_carries_its_own_verdict_provenance(tmp_path: Path) -> None:
    result = _mock_result(tmp_path)
    assert result["instances"]
    for row in result["instances"]:
        provenance = row["verdict_provenance"]
        assert provenance["implementation"] == "redrob-generate"
        assert provenance["implementation_version"]
        assert provenance["unicode_version"]
        assert provenance["authoritative"] is True


def test_code_mix_ratio_is_present_and_null(tmp_path: Path) -> None:
    """Present so the shape does not change later, null because no method is defined."""
    result = _mock_result(tmp_path)
    for row in result["instances"]:
        assert "code_mix_ratio" in row
        assert row["code_mix_ratio"] is None


def test_all_three_paired_deltas_are_present(tmp_path: Path) -> None:
    result = _mock_result(tmp_path)
    assert [row["comparison"] for row in result["aggregates"]["paired_deltas"]] == [
        "english-vs-korean",
        "korean-vs-hindi",
        "hindi-vs-hinglish",
    ]
    for row in result["aggregates"]["paired_deltas"]:
        assert row["n_pairs"] > 0, "a delta over zero pairs would report 0.0 and look computed"


def test_the_table_names_the_unpublishable_locales(tmp_path: Path) -> None:
    rendered = render_table(_mock_result(tmp_path))
    assert "NOT PUBLISHABLE" in rendered
    assert "paired deltas" in rendered


# --------------------------------------------------------------------------- CLI


def _run_cli(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "redrob_generate.cli", *args],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        check=False,
    )


def test_the_study_command_runs_end_to_end_and_reruns_identically(tmp_path: Path) -> None:
    first, second = tmp_path / "a", tmp_path / "b"
    for out in (first, second):
        completed = _run_cli(
            "study",
            "--config",
            str(EXAMPLE_CONFIG),
            "--out",
            str(out),
            "--created-at",
            "2026-01-01T00:00:00Z",
            "--no-peer-probe",
            "--quiet",
        )
        assert completed.returncode == 0, completed.stderr
    assert (first / "result.json").read_bytes() == (second / "result.json").read_bytes()
    assert (first / "aggregates.txt").read_bytes() == (second / "aggregates.txt").read_bytes()


def test_the_study_command_refuses_to_publish_stub_locales(tmp_path: Path) -> None:
    completed = _run_cli(
        "study",
        "--config",
        str(EXAMPLE_CONFIG),
        "--out",
        str(tmp_path / "out"),
        "--created-at",
        "2026-01-01T00:00:00Z",
        "--no-peer-probe",
        "--publish",
        "--quiet",
    )
    assert completed.returncode == 3
    assert "untranslated" in completed.stderr
