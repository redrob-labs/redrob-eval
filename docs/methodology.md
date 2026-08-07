# Routing methodology

This document describes the **routing label** path: outcome-supervised labels for
training a small router that chooses `small` vs `large` before answering.

There are two ways to produce those labels, and they land in the same
`RoutingExample` shape:

- **Metric-derived** (below) - call small and large, score both against gold,
  label `small` when it clears a threshold. Needs a task with reference answers.
- **Preference-derived** - run a blind bracket in Compare and label `small` when
  the fast model beat or tied the fallback. Needs no gold at all. See
  [`docs/preference.md`](preference.md).

Because both write the same rows, the corpus, replay, export and training paths
below apply unchanged to either source.

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
| `qwk`, `cohens_kappa`, `checklist_composite` | `0.6` | Human-agreement floors for checklist / video |
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

- Relative cost weights / percentages only - never absolute prices in UI or exports
- Keys stay server-side
- Exclude blocked / NSFW catalog endpoints (see catalog filters)
- Vendored datasets must be license-compatible; NC material stays in `datasets/local/`

## Video-local datasets (checklist / skill scoring)

Human-labeled skill footage is **not** redistributable under the Apache-compatible
vendored-dataset rule that covers GSM8K / IN22 / fixtures. Those clips stay on the
operator's machine; the repo only documents a **local path schema**.

Convention: `datasets/video-local/<id>.json` (gitignored except README + schema example).

Each manifest (`schemaVersion: 1`) lists:

- `examples[].framePaths` — pre-extracted **frame images** (never persist raw video here)
- `examples[].label` — human ordinal / checklist JSON for QWK / κ / composite metrics
- optional `anchors[]` — 2–3 fixed few-shot frame-sets (beginner/intermediate/skilled)

Loaders: `loadVideoLocalManifest` → `videoLocalToLoadedDataset` in `@redrob/harness`.
During eval, only the frames selected by `frame_policy` are read into memory for that
scoring call; video bytes are never written to logs, `datasets/`, or `exports/`.

Default Evolve metric for checklist / video goals is **quadratic weighted kappa (QWK)**
against those human labels. `abstention_rate` is reported separately and excluded from
the QWK denominator (abstaining on bad lighting/angle is correct, not an error).

Quality floors for this category are QWK thresholds (default ~0.6), not % exact-match.

See `datasets/video-local/README.md`.

## Related

- [`docs/preference.md`](preference.md) - blind brackets, and preference-derived labels
- [`docs/learnings.md`](learnings.md) - living design log
- [`train/README.md`](../train/README.md) - optional MLP / SLM / event-detect training
- [`NOTICE`](../NOTICE) - attributions
