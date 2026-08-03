# Task-grounded preference evaluation

Preference runs generate outputs from K candidate models on M inputs from a
**Custom Goal** task (goal + rubric + input-only JSONL). Later stages collect
blind human votes and fit Bradley-Terry ratings. This document covers **Stage 1:
generation**.

## Why scale matters

Resolving a ~20-point Elo gap between two models at 95% confidence needs on the
order of **thousands of pairwise votes** on that pair. Generation quality
(truncation, identical params) must be solid before any of those votes are spent.

## Stage 1 — generation

- Reuses Custom Goal — no second task format. Optional JSONL `sections: string[]`
  enables fan-out when `generationParams.parallelSections > 1`.
- Storage: `eval/preference-runs/<runId>/` (`meta.json`, `generations.jsonl`,
  `summary.json`, `progress.jsonl`, `run_manifest.json`).
- **Identical generation params** for every model in a run (temperature, maxTokens,
  seed, parallelSections). Default `maxTokens` is **`null` (unlimited)** — providers
  omit the cap or use a high model-allowed ceiling. Set an explicit number to force a
  shared budget (needed to diagnose truncation). Different prompts → different run.
- **`finishReason` is stored verbatim.** Length/token-cap stops contribute to
  per-model `truncationRate`. If any rate is non-zero (or section lengths cluster
  near `maxTokens`), the summary sets `truncationWarning` — do not vote on that
  run until the cap is fixed.
- **Reasoning tokens** are billed as output but absent from the response body.
  They are stored in `usage.reasoningTokens` and **never** folded into
  `usage.outputTokens`.
- **Fail soft:** one cell error does not abort the run; the completion matrix
  records `ok | error | truncated | pending`.

### API / UI

- Web UI: `/preference` — start generation; `/preference/<runId>` — results matrix
  (live SSE + tables)
- `POST /api/preference/runs` — `{ customGoal, modelIds, inputIds?, generationParams?, baselineModelId? }`
- `GET /api/preference/runs` — list
- `GET /api/preference/runs/:id` — meta + summary (truncation warning)
- `GET /api/preference/runs/:id/events` — SSE progress

### Offline verify

```bash
yarn verify:preference-gen
```

## Retention (Stages 2+)

Rater identity will be an **opaque id** only — no names, emails, IPs, or free-text
that could carry identity. Retention policy for votes will be documented here when
the arena lands. Generation artifacts stay on the operator machine under
`eval/preference-runs/` (gitignored with other `eval/` runs).

## Related

- [Compare](compare.md) — multi-axis ranking (registry preference is public Elo today;
  Stage 3 will wire preference-run BT ratings)
- [Methodology](methodology.md) — routing / Custom Goal context
