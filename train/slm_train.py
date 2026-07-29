#!/usr/bin/env python3
"""LoRA fine-tune a small chat model as a routing SLM.

Expects chat JSONL from `yarn export:routing` (messages with assistant = small|large).

Example (GPU recommended):
  pip install -r train/requirements-slm.txt
  python train/slm_train.py \\
    --data exports/routing-chat.jsonl \\
    --base Qwen/Qwen2.5-0.5B-Instruct \\
    --out train/artifacts/slm-qwen05

CPU smoke (tiny steps) also works but is slow.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import read_jsonl, repo_root


def main() -> None:
    ap = argparse.ArgumentParser(description="LoRA fine-tune routing SLM")
    ap.add_argument("--data", type=Path, default=repo_root() / "exports" / "routing-chat.jsonl")
    ap.add_argument("--base", type=str, default="Qwen/Qwen2.5-0.5B-Instruct")
    ap.add_argument("--out", type=Path, default=repo_root() / "train" / "artifacts" / "slm")
    ap.add_argument("--epochs", type=float, default=1.0)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--batch-size", type=int, default=2)
    ap.add_argument("--max-length", type=int, default=512)
    ap.add_argument("--max-samples", type=int, default=0, help="0 = all")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    try:
        import torch
        from datasets import Dataset
        from peft import LoraConfig, TaskType, get_peft_model
        from transformers import (
            AutoModelForCausalLM,
            AutoTokenizer,
            DataCollatorForLanguageModeling,
            Trainer,
            TrainingArguments,
        )
    except ImportError as e:
        raise SystemExit(
            "SLM deps missing. Install with:\n"
            "  pip install -r train/requirements-slm.txt\n"
            f"Import error: {e}"
        )

    if not args.data.exists():
        raise SystemExit(
            f"Missing {args.data}. Run `yarn export:routing` "
            "or use train/fixtures/sample-chat.jsonl"
        )

    rows = read_jsonl(args.data)
    if args.max_samples > 0:
        rows = rows[: args.max_samples]
    if len(rows) < 2:
        raise SystemExit("Need at least 2 chat examples")

    def to_text(row: dict) -> str:
        msgs = row.get("messages") or []
        # Simple chat template fallback
        parts = []
        for m in msgs:
            role = m.get("role", "")
            content = m.get("content", "")
            parts.append(f"<|{role}|>\n{content}")
        return "\n".join(parts) + "<|end|>\n"

    texts = [to_text(r) for r in rows]
    ds = Dataset.from_dict({"text": texts})

    tokenizer = AutoTokenizer.from_pretrained(args.base, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    def tokenize(batch: dict) -> dict:
        return tokenizer(
            batch["text"],
            truncation=True,
            max_length=args.max_length,
            padding=False,
        )

    tokenized = ds.map(tokenize, batched=True, remove_columns=["text"])

    torch_dtype = torch.float16 if torch.cuda.is_available() else torch.float32
    model = AutoModelForCausalLM.from_pretrained(
        args.base,
        trust_remote_code=True,
        torch_dtype=torch_dtype,
        device_map="auto" if torch.cuda.is_available() else None,
    )
    lora = LoraConfig(
        task_type=TaskType.CAUSAL_LM,
        r=8,
        lora_alpha=16,
        lora_dropout=0.05,
        target_modules=["q_proj", "v_proj", "k_proj", "o_proj"],
    )
    try:
        model = get_peft_model(model, lora)
    except ValueError:
        # Some models use different module names
        lora.target_modules = ["c_attn", "c_proj", "query_key_value"]
        model = get_peft_model(model, lora)

    args.out.mkdir(parents=True, exist_ok=True)
    train_args = TrainingArguments(
        output_dir=str(args.out / "checkpoints"),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        learning_rate=args.lr,
        logging_steps=5,
        save_strategy="epoch",
        report_to=[],
        seed=args.seed,
        fp16=torch.cuda.is_available(),
        remove_unused_columns=False,
    )
    collator = DataCollatorForLanguageModeling(tokenizer=tokenizer, mlm=False)
    trainer = Trainer(
        model=model,
        args=train_args,
        train_dataset=tokenized,
        data_collator=collator,
    )
    trainer.train()
    model.save_pretrained(args.out / "adapter")
    tokenizer.save_pretrained(args.out / "adapter")
    meta = {
        "base": args.base,
        "n_examples": len(rows),
        "epochs": args.epochs,
        "max_length": args.max_length,
        "data": str(args.data),
        "device": "cuda" if torch.cuda.is_available() else "cpu",
    }
    (args.out / "meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"adapter": str(args.out / "adapter"), **meta}, indent=2))


if __name__ == "__main__":
    main()
