"""Shared helpers for router training scripts."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterator


TASK_TO_I = {"math": 0, "translation": 1, "classification": 2}
LABEL_TO_I = {"small": 0, "large": 1}
I_TO_LABEL = {0: "small", 1: "large"}


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def write_jsonl(path: Path, rows: Iterator[dict[str, Any]] | list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def features_vector(row: dict[str, Any]) -> list[float]:
    """Build numeric vector from flat export row (no gold / score leakage)."""
    feat = row.get("features") or {}
    return [
        float(feat.get("charLen", 0)),
        float(feat.get("wordCount", 0)),
        float(feat.get("digitCount", 0)),
        float(feat.get("sentenceCount", 0)),
        float(feat.get("questionMarkCount", 0)),
        float(feat.get("newlineCount", 0)),
        float(feat.get("avgWordLen", 0)),
        float(feat.get("heuristicScore", 0)),
        1.0 if feat.get("heuristicComplexity") == "hard" else 0.0,
        float(TASK_TO_I.get(str(feat.get("task") or row.get("task") or ""), 0)),
    ]


def label_index(row: dict[str, Any]) -> int:
    lab = row.get("label")
    if lab not in LABEL_TO_I:
        raise ValueError(f"Unknown label: {lab!r}")
    return LABEL_TO_I[lab]
