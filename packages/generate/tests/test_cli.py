# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""The CLI, which is the only bridge boundary between the two implementations."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from redrob_generate.cli import INSTANCES_FILENAME, MANIFEST_FILENAME, main

TEMPLATE = "math/linear-equation"


def _emit(templates_dir: Path, out: Path, count: int = 5, created_at: str = "2026-01-01T00:00:00Z") -> int:
    return main(
        [
            "emit",
            "--template",
            str(templates_dir / TEMPLATE),
            "--count",
            str(count),
            "--out",
            str(out),
            "--created-at",
            created_at,
            "--quiet",
        ]
    )


def test_emit_writes_instances_and_manifest(templates_dir: Path, tmp_path: Path) -> None:
    assert _emit(templates_dir, tmp_path / "set") == 0
    instances = (tmp_path / "set" / INSTANCES_FILENAME).read_text(encoding="utf-8")
    manifest = json.loads((tmp_path / "set" / MANIFEST_FILENAME).read_text(encoding="utf-8"))
    assert len(instances.strip().splitlines()) == 5
    assert manifest["instance_count"] == 5
    assert manifest["templates"][0]["id"] == "math.linear_equation"


def test_emit_is_byte_identical_across_runs(templates_dir: Path, tmp_path: Path) -> None:
    """The determinism claim, checked on the bytes rather than on parsed objects."""
    _emit(templates_dir, tmp_path / "a")
    _emit(templates_dir, tmp_path / "b")
    for name in (INSTANCES_FILENAME, MANIFEST_FILENAME):
        assert (tmp_path / "a" / name).read_bytes() == (tmp_path / "b" / name).read_bytes()


def test_only_the_timestamp_differs_when_the_clock_moves(
    templates_dir: Path, tmp_path: Path
) -> None:
    _emit(templates_dir, tmp_path / "a", created_at="2026-01-01T00:00:00Z")
    _emit(templates_dir, tmp_path / "b", created_at="2030-06-15T12:34:56Z")
    assert (tmp_path / "a" / INSTANCES_FILENAME).read_bytes() == (
        tmp_path / "b" / INSTANCES_FILENAME
    ).read_bytes()
    first = json.loads((tmp_path / "a" / MANIFEST_FILENAME).read_text(encoding="utf-8"))
    second = json.loads((tmp_path / "b" / MANIFEST_FILENAME).read_text(encoding="utf-8"))
    assert first.pop("created_at") != second.pop("created_at")
    assert first == second


def test_emitted_files_end_with_exactly_one_newline(templates_dir: Path, tmp_path: Path) -> None:
    _emit(templates_dir, tmp_path / "set", count=2)
    for name in (INSTANCES_FILENAME, MANIFEST_FILENAME):
        data = (tmp_path / "set" / name).read_bytes()
        assert data.endswith(b"\n")
        assert not data.endswith(b"\n\n")
        assert b"\r" not in data


def test_emit_prints_a_citation_notice(
    templates_dir: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    main(
        [
            "emit",
            "--template",
            str(templates_dir / TEMPLATE),
            "--count",
            "1",
            "--out",
            str(tmp_path / "set"),
            "--created-at",
            "2026-01-01T00:00:00Z",
        ]
    )
    notice = capsys.readouterr().err
    assert "Cite this set" in notice
    assert notice.strip().count("\n") == 0, "the notice must be one line"


def test_verify_reports_per_item_results(templates_dir: Path, tmp_path: Path, capsys) -> None:
    set_dir = tmp_path / "set"
    _emit(templates_dir, set_dir, count=3)
    instances = [
        json.loads(line)
        for line in (set_dir / "instances.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    outputs = tmp_path / "outputs.jsonl"
    outputs.write_text(
        "\n".join(
            json.dumps(
                {
                    "instance_index": instance["instance_index"],
                    "output": f"{instance['derived']['answer']:.4f}",
                }
            )
            for instance in instances
        ),
        encoding="utf-8",
    )
    capsys.readouterr()
    assert main(["verify", "--set", str(set_dir), "--outputs", str(outputs), "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["instance_count"] == 3
    assert payload["passed_count"] == 3
    assert [result["code"] for result in payload["results"]] == ["ok", "ok", "ok"]


def test_verify_exit_code_is_nonzero_when_something_fails(
    templates_dir: Path, tmp_path: Path, capsys
) -> None:
    set_dir = tmp_path / "set"
    _emit(templates_dir, set_dir, count=2)
    outputs = tmp_path / "outputs.json"
    outputs.write_text(json.dumps({"0": "0", "1": "0"}), encoding="utf-8")
    capsys.readouterr()
    assert main(["verify", "--set", str(set_dir), "--outputs", str(outputs), "--json"]) == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["passed_count"] < payload["instance_count"]


def test_verify_flags_missing_outputs_rather_than_skipping_them(
    templates_dir: Path, tmp_path: Path, capsys
) -> None:
    """A missing output must never be silently omitted from the denominator."""
    set_dir = tmp_path / "set"
    _emit(templates_dir, set_dir, count=3)
    outputs = tmp_path / "outputs.json"
    outputs.write_text(json.dumps([]), encoding="utf-8")
    capsys.readouterr()
    assert main(["verify", "--set", str(set_dir), "--outputs", str(outputs), "--json"]) == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["instance_count"] == 3
    assert payload["passed_count"] == 0
    assert all(result["code"] == "parse_error" for result in payload["results"])


def test_verify_accepts_jsonl_and_json_forms(templates_dir: Path, tmp_path: Path, capsys) -> None:
    set_dir = tmp_path / "set"
    _emit(templates_dir, set_dir, count=2)
    instances = [
        json.loads(line)
        for line in (set_dir / "instances.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    answers = [f"{instance['derived']['answer']:.4f}" for instance in instances]

    jsonl = tmp_path / "a.jsonl"
    jsonl.write_text(
        "\n".join(json.dumps({"instance_index": i, "output": a}) for i, a in enumerate(answers)),
        encoding="utf-8",
    )
    array = tmp_path / "b.json"
    array.write_text(json.dumps(answers), encoding="utf-8")

    for path in (jsonl, array):
        capsys.readouterr()
        assert main(["verify", "--set", str(set_dir), "--outputs", str(path), "--json"]) == 0


def test_verify_can_refuse_executable_verifiers(tmp_path: Path, capsys) -> None:
    set_dir = tmp_path / "set"
    set_dir.mkdir()
    instance = {
        "spec_version": "redrob-verifiable-task/v1",
        "template_id": "t.symbolic",
        "template_version": "1.0.0",
        "template_hash": "sha256:" + "0" * 64,
        "locale": "en",
        "instance_index": 0,
        "seed": "1",
        "parameters": {},
        "prompt": "expand (x+1)^2",
        "verifier": {"type": "sympy_equiv", "expected": "(x+1)**2", "symbols": ["x"]},
    }
    (set_dir / "instances.jsonl").write_text(json.dumps(instance) + "\n", encoding="utf-8")
    (tmp_path / "outputs.json").write_text(json.dumps(["x**2+2*x+1"]), encoding="utf-8")

    capsys.readouterr()
    assert (
        main(
            [
                "verify",
                "--set",
                str(set_dir),
                "--outputs",
                str(tmp_path / "outputs.json"),
                "--json",
                "--no-executable",
            ]
        )
        == 1
    )
    payload = json.loads(capsys.readouterr().out)
    assert payload["results"][0]["code"] == "unsupported_verifier"
    assert payload["results"][0]["passed"] is False


def test_verify_on_a_directory_without_a_set_fails_cleanly(tmp_path: Path, capsys) -> None:
    (tmp_path / "outputs.json").write_text("[]", encoding="utf-8")
    assert (
        main(["verify", "--set", str(tmp_path), "--outputs", str(tmp_path / "outputs.json")]) == 2
    )
    assert "instances.jsonl" in capsys.readouterr().err
