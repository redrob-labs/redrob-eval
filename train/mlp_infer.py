#!/usr/bin/env python3
"""Run a trained MLP router on flat JSONL (or a single feature blob).

Example:
  python train/mlp_infer.py --model train/artifacts/mlp/model.joblib --data exports/routing-flat.jsonl
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import joblib
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import I_TO_LABEL, features_vector, read_jsonl, repo_root, write_jsonl


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", type=Path, required=True)
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Optional JSONL of {id, pred, proba_small, proba_large}",
    )
    args = ap.parse_args()

    pipe = joblib.load(args.model)
    rows = read_jsonl(args.data)
    X = np.array([features_vector(r) for r in rows], dtype=np.float64)
    pred = pipe.predict(X)
    proba = pipe.predict_proba(X) if hasattr(pipe, "predict_proba") else None

    out_rows = []
    for i, row in enumerate(rows):
        item = {
            "id": row.get("id"),
            "pred": I_TO_LABEL[int(pred[i])],
            "gold": row.get("label"),
        }
        if proba is not None:
            # classes_ order from pipeline
            classes = list(pipe.named_steps["mlp"].classes_)
            p = proba[i]
            item["proba_small"] = float(p[classes.index(0)]) if 0 in classes else None
            item["proba_large"] = float(p[classes.index(1)]) if 1 in classes else None
        out_rows.append(item)

    correct = sum(1 for r in out_rows if r.get("gold") and r["pred"] == r["gold"])
    labeled = sum(1 for r in out_rows if r.get("gold") in ("small", "large"))
    summary = {
        "n": len(out_rows),
        "accuracy_vs_gold": (correct / labeled) if labeled else None,
    }
    print(json.dumps(summary, indent=2))

    out = args.out or (repo_root() / "train" / "artifacts" / "mlp" / "infer.jsonl")
    write_jsonl(out, out_rows)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
