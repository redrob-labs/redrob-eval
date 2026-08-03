# redrob-eval

[![CI](https://github.com/savagemanage/redrob-eval/actions/workflows/ci.yml/badge.svg)](https://github.com/savagemanage/redrob-eval/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

Open-source **evolution harness** for Indian-language LLM configurations (Next.js App Router, Apache 2.0).

Given a task, dataset, and quality floor, search for the cheapest configuration (prompt + demos + model + script handling) that serves Indic users at acceptable quality. Model selection is one gene in the search space - the harness is the product.

## Findings

- Hand-written routing rules (prompt length, keywords) agreed with dual-model labels only about 25% of the time on some GSM8K slices. Not usable as a production policy. (See [`docs/learnings.md`](docs/learnings.md); dual-eval corpora stay under gitignored `eval/routing-runs/`.)
- A learned router trained on those labels failed to beat chance on the labels we cared about, and was dropped. The labeling pipeline survived; the router did not.
- Indic tokenizer fertility is a hard budget constraint: high fertility shrinks how many demonstrations fit, so `demos_requested` and `demos_fitted` diverge and the effective search space narrows on exactly the languages this targets.

## Sample results (committed)

Regenerate offline with `yarn export:samples` (no API keys). Full files live in [`exports/samples/`](exports/samples/).

**Baseline vs evolved (excerpt):**

```text
Dataset: in22-gen-hi-en · Optimizer: gepa · Quality floor: 0.5

Baseline  val quality 0.6000 · val tokens 200 · demos 3/2
Evolved   val quality 0.7000 · val tokens 120 · demos 3/3

Token Δ (val): -80
Quality Δ (val): +0.1000
Relative cost vs baseline: 62.5%
```

![Pareto: relative cost % vs val quality for baseline and evolved](exports/samples/pareto.svg)

Port is fixed at **`3939`**.

## Requirements

- **Node.js** 20+ (tested on 22)
- **Yarn** Classic 1.22 (`yarn` via Corepack is fine)
- An [OpenRouter](https://openrouter.ai/) API key (recommended) or another supported provider key

## Quick start

```bash
git clone https://github.com/savagemanage/redrob-eval.git
cd redrob-eval
cp .env.example .env
# Edit .env and set OPENROUTER_API_KEY=...
yarn install
yarn verify:phase1
yarn verify:gepa
yarn verify:phase3
yarn verify:compare
yarn export:samples
yarn dev
```

Open [http://localhost:3939](http://localhost:3939). Restart `yarn dev` after editing `.env`.

Nothing else is required for a clean checkout - evaluation runs offline against vendored datasets; only provider API calls leave the machine. CI runs every `yarn verify:*` plus `yarn export:samples` and `yarn build` on each push.

## What it does

| Mode | Purpose |
|------|---------|
| **Evolve** | GEPA search over instruction / demos / model / `script_policy` / `frame_policy` under a quality floor; catalog datasets or custom goal+rubric (LLM judge or checklist QWK); export baseline-vs-evolved report |
| **Text** | Dual-eval small+large collection for outcome-supervised routing labels; SSE jobs survive refresh |
| **Image** | Side-by-side SFW preference (+ optional vision auto-judge) |
| **Compare** | Multi-axis shortlist (quality / preference / relative cost / latency) under a token profile; Pareto + markdown export; offline `yarn verify:compare` |

Checklist / video skill scoring (custom goal `mode: "checklist"` or `datasets/video-local/` manifests) evolves a judging prompt + `frame_policy` for agreement with human graders (QWK), not task accuracy. Frames are sampled in memory only - no video bytes are persisted.

Shared rules:

- Provider keys via server `.env` only (never sent to the browser)
- Costs are **relative percentages** of a run baseline - never absolute currency
- Metrics return `{ score, feedback }` text alongside the number
- Train/val may be optimized against; **test is reported once** and the API refuses reporting test if it was also optimized against

## Monorepo layout

| Path | Role |
|------|------|
| `apps/web` | Next.js UI + API routes |
| `packages/harness` | Optimizer, eval, metrics, datasets, providers (`@redrob/harness`) |
| `packages/tokenizers` | Fertility via HF `AutoTokenizer` (`@redrob/tokenizers`) |
| `datasets/` | Vendored eval subsets (Apache-compatible licenses only); `video-local/` for non-redistributable checklist manifests |
| `exports/samples/` | Committed, regenerable sample Evolve report + Pareto SVG |
| `scripts/parity/` | Optional research comparison vs reference GEPA - **not** needed to run the app |
| `train/` | Optional Python router training - **not** on the `yarn install && yarn dev` path |

Workspace packages are marked `"private": true` (consumed in-repo; not published to npm).

## Attribution - GEPA

This repo reimplements [GEPA](https://github.com/gepa-ai/gepa) (Genetic-Pareto) in TypeScript from the paper ([arXiv:2507.19457](https://arxiv.org/abs/2507.19457)). Cite as **agrawal2025gepa**. See [`NOTICE`](NOTICE). Implementation: `packages/harness/src/lib/optimizer/gepa/` - not a file-by-file port of `src/gepa/`.

On **Evolve**, pick a catalog dataset or **Custom goal** (goal + rubric + input-only JSONL; LLM-as-judge). **Seed model** runs the candidate prompt; **reflect model** rewrites it from failure feedback; **judge** (custom mode) scores answers against your rubric. Offline: `yarn verify:gepa`, `yarn verify:phase3`, `yarn verify:custom-goal`. Export reports via `GET /api/optimize/runs/:id?export=md`.

## Docs

- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [Methodology](docs/methodology.md) - routing labels, features, export
- [Compare](docs/compare.md) - multi-axis model ranking (relative cost only)
- [Learnings](docs/learnings.md) - living design log
- [Sample exports](exports/samples/README.md) - regenerable report + Pareto

## Environment

| Variable | Provider |
|----------|----------|
| `OPENROUTER_API_KEY` | OpenRouter (recommended) |
| `OPENAI_API_KEY` | OpenAI |
| `ANTHROPIC_API_KEY` | Anthropic |
| `GOOGLE_API_KEY` | Google Gemini |
| `TOGETHER_API_KEY` | Together |
| `FIREWORKS_API_KEY` | Fireworks |
| `HF_TOKEN` | Hugging Face (optional; dataset fetcher only) |

Keep `.env` at the **repo root**. Next loads it via `apps/web/next.config.ts`.

## API (high level)

**Optimize / Evolve**

- `POST /api/optimize` → `{ runId }`
- `GET /api/optimize/runs/:id/events` - SSE
- `GET /api/optimize/runs/:id` - meta + result + report
- `GET /api/optimize/runs/:id?export=md|json` - downloadable report

**Routing collection**

- `POST /api/routing/collect` → `{ runId }`
- `GET /api/routing/runs/:id/events` - SSE
- `GET /api/routing/export?format=chat|flat` - training JSONL

Also: `/api/models`, `/api/datasets`, `/api/image/*`, `/api/status`, …

## CLI

```bash
yarn verify:phase1   # datasets, splits, relative cost helpers
yarn verify:gepa     # GEPA unit checks (offline)
yarn verify:phase3   # script_policy, demo fit, report (offline)
yarn verify:custom-goal  # custom goal parse + judge JSON (offline)
yarn verify:video    # frame_policy, QWK, rubric lint (offline)
yarn export:samples  # write exports/samples report + Pareto SVG
yarn typecheck
yarn build
yarn probe
yarn datasets:fetch  # regenerate vendored JSON (not needed at runtime)
yarn export:routing
```

### Optional: train routers (Python research)

```bash
pip install -r train/requirements-mlp.txt
yarn train:mlp
yarn train:event-detect
```

See [`train/README.md`](train/README.md).

## Tips

- Start with **5-20 samples** while iterating
- Exact-match datasets default to threshold `0.99`
- Oracle on the Pareto chart is the training-target upper bound for the labeling rule
- High tokenizer fertility shrinks demos that fit - watch `demos_requested` vs `demos_fitted` on Evolve reports

## Author

Janghoon Lee

## License

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
