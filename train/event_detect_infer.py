#!/usr/bin/env python3
"""Infer event scores for frames using the event-detect MLP.

Emits JSONL with `event_score` in [0,1] for the harness `event_detect` strategy.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import joblib
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import read_jsonl, repo_root
from event_detect_train import FEATURE_KEYS, event_features


def main() -> None:
    ap = argparse.ArgumentParser(description="Infer frame event scores")
    ap.add_argument(
        "--model",
        type=Path,
        default=repo_root() / "train" / "artifacts" / "event-detect" / "model.joblib",
    )
    ap.add_argument(
        "--data",
        type=Path,
        default=repo_root() / "train" / "fixtures" / "sample-event-frames.jsonl",
    )
    ap.add_argument(
        "--out",
        type=Path,
        default=repo_root() / "train" / "artifacts" / "event-detect" / "infer.jsonl",
    )
    args = ap.parse_args()

    blob = joblib.load(args.model)
    pipe = blob["pipeline"] if isinstance(blob, dict) else blob
    rows = read_jsonl(args.data)
    X = np.array([event_features(r) for r in rows], dtype=np.float64)
    if hasattr(pipe, "predict_proba"):
        scores = pipe.predict_proba(X)[:, 1]
    else:
        scores = pipe.predict(X).astype(np.float64)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8") as f:
        for row, score in zip(rows, scores):
            out = {
                **row,
                "event_score": float(score),
                "feature_keys": list(FEATURE_KEYS),
            }
            f.write(json.dumps(out) + "\n")
    print(f"Wrote {args.out} ({len(rows)} rows)")


if __name__ == "__main__":
    main()
