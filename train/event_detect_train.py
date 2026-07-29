#!/usr/bin/env python3
"""Train a cheap frame/event detector MLP for checklist `event_detect` sampling.

Sibling to mlp_train.py — same Pipeline(StandardScaler, MLPClassifier) conventions.
Input: flat JSONL rows with motion / luma features + binary `event` label (0/1).

Example:
  python train/event_detect_train.py --data train/fixtures/sample-event-frames.jsonl
  python train/event_detect_infer.py \\
    --model train/artifacts/event-detect/model.joblib \\
    --data train/fixtures/sample-event-frames.jsonl
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import joblib
import numpy as np
from sklearn.metrics import classification_report
from sklearn.model_selection import train_test_split
from sklearn.neural_network import MLPClassifier
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import read_jsonl, repo_root


FEATURE_KEYS = (
    "motion_energy",
    "luma_mean",
    "luma_std",
    "frame_index_norm",
    "delta_luma_mean",
)


def event_features(row: dict) -> list[float]:
    return [float(row.get(k, 0.0) or 0.0) for k in FEATURE_KEYS]


def event_label(row: dict) -> int:
    v = row.get("event", row.get("label", 0))
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, str):
        return 1 if v.strip().lower() in {"1", "true", "yes", "event"} else 0
    return 1 if float(v) >= 0.5 else 0


def main() -> None:
    ap = argparse.ArgumentParser(description="Train Redrob frame event-detect MLP")
    ap.add_argument(
        "--data",
        type=Path,
        default=repo_root() / "train" / "fixtures" / "sample-event-frames.jsonl",
    )
    ap.add_argument(
        "--out",
        type=Path,
        default=repo_root() / "train" / "artifacts" / "event-detect",
    )
    ap.add_argument("--test-size", type=float, default=0.25)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--max-iter", type=int, default=400)
    args = ap.parse_args()

    if not args.data.exists():
        raise SystemExit(f"Missing {args.data}")

    rows = read_jsonl(args.data)
    if len(rows) < 4:
        raise SystemExit(f"Need at least 4 examples, got {len(rows)}")

    X = np.array([event_features(r) for r in rows], dtype=np.float64)
    y = np.array([event_label(r) for r in rows], dtype=np.int64)

    strat = y if len(set(y.tolist())) > 1 else None
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=args.test_size, random_state=args.seed, stratify=strat
    )

    pipe = Pipeline(
        [
            ("scaler", StandardScaler()),
            (
                "mlp",
                MLPClassifier(
                    hidden_layer_sizes=(32, 16),
                    activation="relu",
                    solver="adam",
                    max_iter=args.max_iter,
                    random_state=args.seed,
                    early_stopping=len(X_train) >= 20,
                ),
            ),
        ]
    )
    pipe.fit(X_train, y_train)
    pred = pipe.predict(X_test)
    report = classification_report(y_test, pred, output_dict=True, zero_division=0)

    args.out.mkdir(parents=True, exist_ok=True)
    model_path = args.out / "model.joblib"
    metrics_path = args.out / "metrics.json"
    joblib.dump({"pipeline": pipe, "feature_keys": FEATURE_KEYS}, model_path)
    metrics_path.write_text(
        json.dumps(
            {
                "n_train": int(len(X_train)),
                "n_test": int(len(X_test)),
                "feature_keys": list(FEATURE_KEYS),
                "report": report,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {model_path}")
    print(f"Wrote {metrics_path}")
    print(classification_report(y_test, pred, zero_division=0))


if __name__ == "__main__":
    main()
