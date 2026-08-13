# redrob-eval

[English](README.md) · [한국어](README.ko.md)

[![CI](https://github.com/redrob-labs/redrob-eval/actions/workflows/ci.yml/badge.svg)](https://github.com/redrob-labs/redrob-eval/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

Open-source **LLM evaluation workbench** (Next.js App Router, Apache 2.0): generate verifiable evaluation prompts from parametric templates, compare any model from any source on your own task, settle quality by blind human preference, evolve configurations under a quality floor, and serve self-hosted models on your GPU.

The product is four modules plus settings: **Compare · Evolve · Deploy · Generate**. Compare is the front door - frontier APIs, OpenRouter, and your own vLLM endpoints all sit in the same list, on text or image, with audio slotting in as one more modality. Generate makes the items the other three run on. Costs, where they appear at all, are **% of a baseline**, never absolute currency. Provider keys stay server-side.

## Findings

- Hand-written routing rules (prompt length, keywords) agreed with dual-model labels only about 25% of the time on some GSM8K slices. Not usable as a production policy. (See [`docs/learnings.md`](docs/learnings.md); dual-eval corpora stay under gitignored `eval/routing-runs/`.)
- A learned router trained on those labels failed to beat chance on the labels we cared about, and was dropped. The labeling pipeline survived; the router did not.
- Tokenizer fertility is a hard budget constraint on high-fertility languages: it shrinks how many demonstrations fit, so `demos_requested` and `demos_fitted` diverge and the effective search space narrows.

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
git clone https://github.com/redrob-labs/redrob-eval.git
cd redrob-eval
cp .env.example .env
# Edit .env and set OPENROUTER_API_KEY=...
yarn install
yarn verify:phase1
yarn verify:gepa
yarn verify:phase3
yarn export:samples
yarn dev
```

Open [http://localhost:3939](http://localhost:3939), which lands on Compare. The other pages are `/evolve`, `/deploy`, `/generate` and `/settings`. Restart `yarn dev` after editing `.env`.

The workbench follows your operating system's light or dark setting, and changes with it. To pin one instead, use the icon at the right of the title bar or the Appearance card in Settings; the choice is stored in the browser, not in `.env`. `yarn verify:theme` prints the contrast of every colour pairing in both palettes, and `yarn test` fails if dark falls below what light manages.

Nothing else is required for a clean checkout - evaluation runs offline against vendored datasets; only provider API calls leave the machine. CI runs every `yarn verify:*` plus `yarn export:samples` and `yarn build` on each push.

## What it does

| Module | Path | Purpose |
|------|------|---------|
| **Compare** | `/` or `/compare` | Run any model from any source live on a catalog dataset or your own prompts, on text or image; rank by measured quality, latency, TTFT and throughput; settle unscored tasks with a blind preference tournament; turn those votes into a routing policy. Task **Tool routing** evaluates the picked models with one shared JSON contract on six-, eighteen-, and fifty-tool scenarios across selectable languages (fertility optional). |
| **Evolve** | `/evolve` | GEPA search over instruction / demos / model / `script_policy` / `frame_policy` under a quality floor; catalog datasets or custom goal+rubric (LLM judge or checklist QWK); export baseline-vs-evolved report |
| **Deploy** | `/deploy` | Serve self-hosted S+L on your GPU host over SSH - measure, start, health, benchmark, resumable terminal |
| **Generate** | `/generate` | Browse parametric task templates and their locales, sample instances from content-derived seeds, and run a cross-locale study to a validated results artifact; export either, or hand the prompts straight to Compare |
| **Settings** | `/settings` | Provider keys and GPU host config, written to the gitignored root `.env`; also the light / dark / system theme |

Typical loop: **Generate** a verifiable prompt set (or pick a catalog dataset) → **Compare** to pick a model → **Evolve** under a quality floor → **Deploy** what you chose, then compare the served endpoint against the frontier again. For tool-routing SLMs: **Deploy** (install / measure / serve) → **Compare** with modality Tool routing.

### Generate

**Generate** is parametric generation of verifiable evaluation prompts together with their
verifiers. An item is a template plus a seed rather than a row in a file, and the seed is *derived*
from the generator version, the template id and the instance index rather than chosen. That buys
two things a static set cannot have. The items cannot have leaked into pretraining, because they
did not exist until someone ran the generator. And cherry-picking becomes structurally impossible
rather than discouraged, because any third party can recompute the same seeds from published values
and check them, which a conventional seed such as `42` does not allow. Scoring is done by
deterministic verifiers, not by a judge model.

Underneath the page are the [Redrob Verifiable Task Spec v2](spec/verifiable-task-v2.md), a Python
generator, verifiers implemented natively in both languages, and a cross-language conformance suite
that fails CI if the two ever disagree.

**Python stays optional.** `yarn install && yarn dev` is unchanged and still works on a machine
with no interpreter installed; CI has a job that builds with Python removed from `PATH` to keep it
that way. The TypeScript side reads and audits generated sets and runs every declarative verifier
natively, and it reaches for Python only through an explicit subprocess call that reports absence
with an actionable message instead of failing. `/generate` behaves the same way: without the CLI it
still lists the template catalog, which is read from disk, and says plainly that sampling needs an
interpreter rather than failing one button at a time.

```bash
# optional: only needed to sample instances or run a study
python -m venv .venv-generate
.venv-generate/Scripts/python -m pip install -e packages/generate   # Windows
# .venv-generate/bin/pip install -e packages/generate               # macOS / Linux

# point the workbench at the venv CLI (repo-root .env; not on PATH by default)
# REDROB_GENERATE_CMD=/absolute/path/to/.venv-generate/.../redrob-generate

redrob-generate emit --template templates/math/linear-equation --count 20 --out /tmp/set
redrob-generate verify --set /tmp/set --outputs answers.jsonl --json
yarn test                                            # the TypeScript half of the conformance suite
```

See [`packages/generate/README.md`](packages/generate/README.md) for a worked example,
[`packages/generate/STUDY.md`](packages/generate/STUDY.md) for running a study, and
[`templates/README.md`](templates/README.md) for the template layout. Templates are English-only in
substance: `hi`, `hi-Latn` and `ko` locale files exist so the pipeline can be exercised end to end,
but they hold the English prompt verbatim and are marked `untranslated`. A real translation needs
native-speaker review, none has had one, and a publishable artifact refuses to build over them.

### Compare's four stages

1. **Setup** - pick a modality (text, image, or tool routing), pick models across every source (curated, OpenRouter, direct frontier, self-hosted vLLM), then a catalog dataset, an image prompt suite, or your own prompts pasted or uploaded as JSONL. Tool routing uses the SLM registry, served model id, and stub fixtures instead.
2. **Run** - streams live over SSE. Quality is scored only when the task has reference answers; latency, TTFT and throughput are always measured on this run. No cost column, because published pricing is never real time.
3. **Preference** - one single-elimination bracket per prompt. Two answers at a time with model names hidden, winner advances, champion takes the prompt. Non-power-of-two fields pad with byes; a model that errored on a prompt loses by walkover. For image, "let the judge decide" hands a match to a vision model and you can still vote the rest. Votes append to `eval/tournaments/{runId}/votes.jsonl`.
4. **Optimize route** - name a fast model and a fallback. Every prompt the fast one won or tied becomes a `small` label, the rest escalate. These land in the same `RoutingExample` corpus the metric-derived collector fills, so `/api/routing/export` and the training path are unchanged - the supervision is just human now instead of metric.

Offline check for the bracket and label logic: `yarn verify:tournament`.

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
| `spec/` | Redrob Verifiable Task Spec v2 + the cross-language conformance suite |
| `templates/` | Generate templates, one directory per family, with locale layers |
| `packages/generate` | Optional Python generator `redrob-generate` - **not** on the `yarn install && yarn dev` path |
| `train/` | Optional Python router training - **not** on the `yarn install && yarn dev` path |

Workspace packages are marked `"private": true` (consumed in-repo; not published to npm).

## Attribution - GEPA

This repo reimplements [GEPA](https://github.com/gepa-ai/gepa) (Genetic-Pareto) in TypeScript from the paper ([arXiv:2507.19457](https://arxiv.org/abs/2507.19457)). Cite as **agrawal2025gepa**. See [`NOTICE`](NOTICE). Implementation: `packages/harness/src/lib/optimizer/gepa/` - not a file-by-file port of `src/gepa/`.

On **Evolve**, pick a catalog dataset or **Custom goal** (goal + rubric + input-only JSONL; LLM-as-judge). **Seed model** runs the candidate prompt; **reflect model** rewrites it from failure feedback; **judge** (custom mode) scores answers against your rubric. Offline: `yarn verify:gepa`, `yarn verify:phase3`, `yarn verify:custom-goal`. Export reports via `GET /api/optimize/runs/:id?export=md`.

## Docs

- [Contributing](CONTRIBUTING.md) - setup, and the branching model: `main` is production and only
  takes releases, `develop` is what you branch from and target
- [Security](SECURITY.md)
- [Methodology](docs/methodology.md) - routing labels, features, export
- [Experiment registry](docs/registry.md) - one record every kind of run shares, what
  `yarn runs` gives you, and why storage is a configuration value
- [Preference](docs/preference.md) - blind brackets, and how votes become routing labels
- [Learnings](docs/learnings.md) - living design log
- [Decision records](docs/decisions/) - why a design is the way it is, one file per decision,
  numbered and never rewritten in place. Start with
  [0001 Generate module foundation](docs/decisions/0001-generate-foundation.md), then
  [0002 Unicode semantics](docs/decisions/0002-unicode-semantics.md),
  [0003 List-valued verifier field](docs/decisions/0003-list-valued-verifier-field.md),
  [0004 Branching model](docs/decisions/0004-branching-model.md) and
  [0005 Study runner](docs/decisions/0005-study-runner.md).
- [Running a study](packages/generate/STUDY.md) - the config format for
  `redrob-generate study`, a worked example against the mock provider, and why the stub locales
  cannot be published
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
| `HF_TOKEN` | Hugging Face (dataset fetcher; required for GPU deploy downloads) |
| `VLLM_API_KEY` | Self-hosted vLLM bearer (auto-issued by `/deploy` if unset) |
| `VLLM_PORT` | Port exposed by Deploy (default: vLLM convention `8000`) |
| `VLLM_BASE_URL` | OpenAI-compatible endpoint for the deployed model (default: `http://localhost:8000/v1`; set to the GPU host for a remote deploy) |
| `REDROB_GENERATE_CMD` | Optional absolute path to the `redrob-generate` executable (e.g. inside `.venv-generate`); when unset the workbench looks for it on `PATH` |

Set every key at `/settings` in the app, or via the environment. GPU deploy details (`GPU_HOST`, `GPU_USER`, `GPU_SSH_KEY`, …) never leave the gitignored root `.env`. See [`deploy/README.md`](deploy/README.md). Do not put hostnames, usernames, key paths, or API keys in the repo.

### Self-hosted relative cost

Self-hosted models have no API $/token. Relative cost uses measured throughput:

`relativeCostWeight(m) = 100 * (tok_per_sec_large / tok_per_sec_m)`

A large model alone = 100 (GPU-time per token). Run **Benchmark** on `/deploy` once the model is serving; it records `MEASURED_TOK_PER_SEC` on the GPU host and the app attributes it to that model and no other. One model is served at a time, so comparing candidates means deploying each in turn. FP8 vs bf16 must appear in result caveats, so never mix precisions in one table without that note.

Indic large-candidate A/B (Gemma 4 31B vs Qwen3.6 27B): compare on the **IN22-Gen** slice (`in22-gen-hi-en`).

Keep `.env` at the **repo root**. Next loads it via `apps/web/next.config.ts`.

## API (high level)

**Optimize / Evolve**

- `POST /api/optimize` → `{ runId }`
- `GET /api/optimize/runs/:id/events` - SSE
- `GET /api/optimize/runs/:id` - meta + result + report
- `GET /api/optimize/runs/:id?export=md|json` - downloadable report

**Compare**

- `POST /api/compare/run` - SSE; dispatches on `modality` (`text` | `image`)
- `POST /api/compare/tournament` - build one bracket per prompt from a run's answers
- `GET /api/compare/tournament/:id` - meta + brackets + votes + standings
- `POST /api/compare/tournament/:id/vote` - record a blind vote and advance
- `POST /api/compare/tournament/:id/judge` - let the modality's model judge decide one match
- `POST /api/compare/tournament/:id/route-policy` - preference labels, save rate, optional corpus write

**Routing collection**

- `POST /api/routing/collect` → `{ runId }`
- `GET /api/routing/runs/:id/events` - SSE
- `GET /api/routing/export?format=chat|flat` - training JSONL

**Headless**

- `POST /api/eval` - SSE text eval with the optional router baseline (`includeRouter`)
- `POST /api/preference/runs` - K×M preference generation, no UI needed
- `GET|POST /api/score` - metric fixtures and one-off scoring

Also: `/api/models`, `/api/datasets`, `/api/image/suites`, `/api/generate/*`, `/api/status`, `/api/probe`, …

## CLI

```bash
yarn verify:phase1   # datasets, splits, relative cost helpers
yarn verify:gepa     # GEPA unit checks (offline)
yarn verify:phase3   # script_policy, demo fit, report (offline)
yarn verify:custom-goal  # custom goal parse + judge JSON (offline)
yarn verify:video    # frame_policy, QWK, rubric lint (offline)
yarn verify:tournament   # preference brackets + preference-derived routing labels (offline)
yarn verify:selfhosted   # self-hosted catalog + relative cost, no currency (offline)
yarn verify:preference-gen  # preference run planning + matrix (offline)
yarn export:samples  # write exports/samples report + Pareto SVG
yarn test            # TypeScript conformance suite for the Generate spec (offline)
yarn generate:spec-types  # regenerate TS types from spec/verifiable-task-v2.schema.json
yarn typecheck
yarn lint
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

Built by Janghoon Lee (이장훈)

## License

Apache-2.0. Copyright 2026 Redrob. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
