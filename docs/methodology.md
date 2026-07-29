# Routing methodology

This document describes the **text routing collection** path: outcome-supervised
labels for training a small router that chooses `small` vs `large` before answering.

The product as a whole is an **evolution harness** (see the README Evolve tab /
GEPA). Routing data collection is one mode that feeds optional research training
under `train/`.

Designed for open-source publication: absolute currency is never required; we
use unitless relative cost weights.

## Goal

Maximize **quality retention** vs a large baseline while lowering **relative cost**,
by routing easy queries to a cheaper model.

The router is **not** trained to guess “difficulty” from vibes. It is trained to predict:

> Will the small model be good enough on this input?

## Collection pipeline

For each sample `(input, gold)`:

1. Call **small** and **large** independently (temperature 0).
2. Score both with the dataset metric (GSM8K exact, accuracy, chrF, …).
3. Extract **features from the input only** (no gold leakage).
4. Assign an **oracle label**:
   - `small` if `small.score ≥ smallOkThreshold` (and small did not error)
   - else `large`
5. Persist the example to:
   - `eval/routing-runs/<runId>/examples.jsonl`
   - `eval/routing-corpus/examples.jsonl` (global corpus)
6. **Replay** policies without extra calls:
   - `small` / `large` alone
   - `heuristic` (length/keyword complexity → tier)
   - `oracle` / `cascade` (follow labels; cascade offline ≡ threshold escalate)

## Label threshold defaults

| Metric | Default `smallOkThreshold` | Rationale |
|--------|----------------------------|-----------|
| `gsm8k_exact`, `accuracy` | `0.99` | Exact tasks: small must essentially nail it |
| `chrf` | `0.55` | Soft metric; “good enough” band |
| other | `0.9` | Conservative |

Thresholds are configurable per collection run.

## Features (training inputs)

Stored on each example under `features` (input-only):

- `charLen`, `wordCount`, `digitCount`, `sentenceCount`
- `questionMarkCount`, `newlineCount`, `avgWordLen`
- `heuristicScore`, `heuristicComplexity`, `heuristicReasons`
- `task`, `datasetId`

## Export formats

```bash
yarn export:routing                 # chat JSONL → exports/routing-chat.jsonl
yarn export:routing --format=flat   # feature+label rows
```

Or `GET /api/routing/export?format=chat|flat&runId=&datasetId=&label=`.

## Open-source constraints

- Relative cost weights / percentages only — never absolute prices in UI or exports
- Keys stay server-side
- Exclude blocked / NSFW catalog endpoints (see catalog filters)
- Vendored datasets must be license-compatible; NC material stays in `datasets/local/`

## Related

- [`docs/learnings.md`](learnings.md) — living design log
- [`train/README.md`](../train/README.md) — optional MLP / SLM training
- [`NOTICE`](../NOTICE) — attributions
