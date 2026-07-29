#!/usr/bin/env python3
"""Train a feature MLP (sklearn) router on flat routing JSONL.

Example:
  python train/mlp_train.py --data exports/routing-flat.jsonl --out train/artifacts/mlp
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import joblib
import numpy as np
from sklearn.metrics import classification_report, confusion_matrix
from sklearn.model_selection import train_test_split
from sklearn.neural_network import MLPClassifier
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import I_TO_LABEL, features_vector, label_index, read_jsonl, repo_root


def main() -> None:
    ap = argparse.ArgumentParser(description="Train Redrob feature MLP router")
    ap.add_argument(
        "--data",
        type=Path,
        default=repo_root() / "exports" / "routing-flat.jsonl",
        help="Flat JSONL from yarn export:routing --format=flat",
    )
    ap.add_argument(
        "--out",
        type=Path,
        default=repo_root() / "train" / "artifacts" / "mlp",
    )
    ap.add_argument("--test-size", type=float, default=0.2)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--max-iter", type=int, default=500)
    args = ap.parse_args()

    if not args.data.exists():
        raise SystemExit(
            f"Missing {args.data}. Run collection + "
            "`yarn export:routing --format=flat` first "
            "(or use train/fixtures/sample-flat.jsonl)."
        )

    rows = read_jsonl(args.data)
    if len(rows) < 4:
        raise SystemExit(f"Need at least 4 examples, got {len(rows)}")

    X = np.array([features_vector(r) for r in rows], dtype=np.float64)
    y = np.array([label_index(r) for r in rows], dtype=np.int64)

    # Stratify when both classes present
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
                    hidden_layer_sizes=(64, 32),
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
    report = classification_report(
        y_test, pred, target_names=["small", "large"], output_dict=True, zero_division=0
    )
    cm = confusion_matrix(y_test, pred).tolist()

    args.out.mkdir(parents=True, exist_ok=True)
    model_path = args.out / "model.joblib"
    joblib.dump(pipe, model_path)
    metrics = {
        "n_total": len(rows),
        "n_train": int(len(X_train)),
        "n_test": int(len(X_test)),
        "accuracy": float(report["accuracy"]),
        "report": report,
        "confusion_matrix": cm,
        "label_order": ["small", "large"],
        "data": str(args.data),
    }
    (args.out / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")

    # Side-by-side predictions on test for inspection
    # Re-split indices isn't stored; re-predict all and mark heuristically
    all_pred = pipe.predict(X)
    preview = []
    for row, yi, pi in zip(rows[:50], y, all_pred):
        preview.append(
            {
                "id": row.get("id"),
                "gold": I_TO_LABEL[int(yi)],
                "pred": I_TO_LABEL[int(pi)],
                "task": row.get("task"),
                "charLen": (row.get("features") or {}).get("charLen"),
            }
        )
    (args.out / "preview.json").write_text(json.dumps(preview, indent=2) + "\n", encoding="utf-8")

    print(json.dumps({"model": str(model_path), **{k: metrics[k] for k in ("n_total", "n_train", "n_test", "accuracy")}}, indent=2))


if __name__ == "__main__":
    main()
