#!/usr/bin/env python3
"""Compare heuristic vs MLP (and optional SLM preds) against oracle labels."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import joblib
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import I_TO_LABEL, features_vector, read_jsonl, repo_root


def accuracy(golds: list[str], preds: list[str]) -> float:
    n = len(golds)
    if n == 0:
        return 0.0
    return sum(1 for g, p in zip(golds, preds) if g == p) / n


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, default=repo_root() / "exports" / "routing-flat.jsonl")
    ap.add_argument("--mlp", type=Path, default=repo_root() / "train" / "artifacts" / "mlp" / "model.joblib")
    ap.add_argument("--slm-preds", type=Path, default=None, help="Optional infer.jsonl from slm_infer.py")
    ap.add_argument("--out", type=Path, default=repo_root() / "train" / "artifacts" / "compare.json")
    args = ap.parse_args()

    rows = read_jsonl(args.data)
    golds = [str(r.get("label")) for r in rows]
    heur = []
    for r in rows:
        feat = r.get("features") or {}
        # flat export stores heuristicComplexity; chat doesn't use this script
        c = feat.get("heuristicComplexity")
        heur.append("large" if c == "hard" else "small")

    report: dict = {
        "n": len(rows),
        "heuristic_accuracy": accuracy(golds, heur),
        "always_small": accuracy(golds, ["small"] * len(rows)),
        "always_large": accuracy(golds, ["large"] * len(rows)),
    }

    if args.mlp.exists():
        pipe = joblib.load(args.mlp)
        X = np.array([features_vector(r) for r in rows], dtype=np.float64)
        pred = [I_TO_LABEL[int(i)] for i in pipe.predict(X)]
        report["mlp_accuracy"] = accuracy(golds, pred)
        report["mlp_model"] = str(args.mlp)
    else:
        report["mlp_accuracy"] = None
        report["mlp_note"] = f"missing {args.mlp}"

    if args.slm_preds and args.slm_preds.exists():
        preds_rows = {r.get("id"): r for r in read_jsonl(args.slm_preds)}
        slm = []
        for r in rows:
            p = preds_rows.get(r.get("id"))
            slm.append((p or {}).get("pred") or "large")
        report["slm_accuracy"] = accuracy(golds, slm)
        report["slm_preds"] = str(args.slm_preds)
    else:
        report["slm_accuracy"] = None

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
