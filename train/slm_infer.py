#!/usr/bin/env python3
"""Inference for a LoRA routing SLM — prints small|large per example.

Example:
  python train/slm_infer.py \\
    --base Qwen/Qwen2.5-0.5B-Instruct \\
    --adapter train/artifacts/slm/adapter \\
    --data exports/routing-chat.jsonl
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import read_jsonl, repo_root, write_jsonl


def extract_label(text: str) -> str:
    t = text.strip().lower()
    if re.search(r"\bsmall\b", t) and not re.search(r"\blarge\b", t):
        return "small"
    if re.search(r"\blarge\b", t):
        return "large"
    for w in reversed(re.findall(r"[a-z]+", t)):
        if w in ("small", "large"):
            return w
    return "large"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", type=str, default="Qwen/Qwen2.5-0.5B-Instruct")
    ap.add_argument("--adapter", type=Path, required=True)
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--max-samples", type=int, default=0)
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()

    try:
        import torch
        from peft import PeftModel
        from transformers import AutoModelForCausalLM, AutoTokenizer
    except ImportError as e:
        raise SystemExit(f"Install train/requirements-slm.txt\n{e}")

    rows = read_jsonl(args.data)
    if args.max_samples > 0:
        rows = rows[: args.max_samples]

    tokenizer = AutoTokenizer.from_pretrained(args.adapter, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    dtype = torch.float16 if torch.cuda.is_available() else torch.float32
    base = AutoModelForCausalLM.from_pretrained(
        args.base,
        trust_remote_code=True,
        torch_dtype=dtype,
        device_map="auto" if torch.cuda.is_available() else None,
    )
    model = PeftModel.from_pretrained(base, str(args.adapter))
    model.eval()
    device = next(model.parameters()).device

    out_rows = []
    correct = 0
    labeled = 0
    for row in rows:
        msgs = row.get("messages") or []
        prompt_msgs = [m for m in msgs if m.get("role") != "assistant"]
        parts = [f"<|{m.get('role')}|>\n{m.get('content', '')}" for m in prompt_msgs]
        prompt = "\n".join(parts) + "\n<|assistant|>\n"

        inputs = tokenizer(prompt, return_tensors="pt").to(device)
        with torch.no_grad():
            gen = model.generate(
                **inputs,
                max_new_tokens=8,
                do_sample=False,
                pad_token_id=tokenizer.eos_token_id,
            )
        new_tokens = gen[0][inputs["input_ids"].shape[1] :]
        text = tokenizer.decode(new_tokens, skip_special_tokens=True)
        pred = extract_label(text)
        gold = None
        for m in msgs:
            if m.get("role") == "assistant":
                gold = str(m.get("content", "")).strip().lower()
                break
        if gold in ("small", "large"):
            labeled += 1
            if pred == gold:
                correct += 1
        out_rows.append(
            {
                "id": row.get("id") or (row.get("meta") or {}).get("sampleId"),
                "pred": pred,
                "gold": gold,
                "raw": text.strip(),
            }
        )

    summary = {
        "n": len(out_rows),
        "accuracy_vs_gold": (correct / labeled) if labeled else None,
    }
    print(json.dumps(summary, indent=2))
    out = args.out or (repo_root() / "train" / "artifacts" / "slm" / "infer.jsonl")
    write_jsonl(out, out_rows)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
