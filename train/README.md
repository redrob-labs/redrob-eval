# Training routers (MLP + SLM)

Optional **research** path (Python). Not required for `yarn install && yarn dev`.

Train **both** on the same outcome labels:

1. **Feature MLP** - cheap, default candidate  
2. **LoRA SLM** - text router for comparison / harder cases  

Both learn `small` | `large` from the collection corpus.

## 0. Data

```bash
# After UI collection runs:
yarn export:routing --format=flat --out=./exports/routing-flat.jsonl
yarn export:routing --format=chat --out=./exports/routing-chat.jsonl

# Or smoke with fixtures:
# train/fixtures/sample-flat.jsonl
# train/fixtures/sample-chat.jsonl
```

## 1. MLP (recommended first)

```bash
python -m venv .venv-train
# Windows: .venv-train\Scripts\activate
source .venv-train/bin/activate

pip install -r train/requirements-mlp.txt

python train/mlp_train.py --data train/fixtures/sample-flat.jsonl
python train/mlp_infer.py \
  --model train/artifacts/mlp/model.joblib \
  --data train/fixtures/sample-flat.jsonl
python train/compare.py --data train/fixtures/sample-flat.jsonl
```

Yarn helpers (uses system `python`):

```bash
yarn train:mlp
yarn train:compare
```

Artifacts: `train/artifacts/mlp/model.joblib`, `metrics.json`.

## 1b. Event-detect MLP (video frame sampling)

Cheap first-pass for checklist `frame_policy.strategy = "event_detect"`. Same
sklearn Pipeline conventions as the routing MLP; features are motion/luma
fingerprints, label is binary “event-like frame”.

```bash
python train/event_detect_train.py --data train/fixtures/sample-event-frames.jsonl
python train/event_detect_infer.py \
  --model train/artifacts/event-detect/model.joblib \
  --data train/fixtures/sample-event-frames.jsonl
```

```bash
yarn train:event-detect
```

The harness falls back to motion-energy peaks when no event scores are supplied.

## 2. SLM LoRA (optional, heavier)

```bash
pip install -r train/requirements-slm.txt

python train/slm_train.py \
  --data train/fixtures/sample-chat.jsonl \
  --base Qwen/Qwen2.5-0.5B-Instruct \
  --out train/artifacts/slm \
  --epochs 1 \
  --max-samples 8

python train/slm_infer.py \
  --base Qwen/Qwen2.5-0.5B-Instruct \
  --adapter train/artifacts/slm/adapter \
  --data train/fixtures/sample-chat.jsonl

python train/compare.py \
  --data train/fixtures/sample-flat.jsonl \
  --slm-preds train/artifacts/slm/infer.jsonl
```

```bash
yarn train:slm   # fixture smoke; override args after --
```

Default base model: **Qwen2.5-0.5B-Instruct** (HF). Swap for Llama-3.2-1B, Gemma-2-2B, etc.

GPU strongly recommended for real corpus sizes; CPU works for fixture smoke only.

## What to compare

`compare.py` reports accuracy vs oracle labels:

- heuristic  
- always-small / always-large  
- MLP  
- SLM (if preds provided)

Log results into `docs/learnings.md`.
