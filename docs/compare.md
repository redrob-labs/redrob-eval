# Multi-axis model comparison

Compare ranks candidate models on **quality**, **human preference**, **relative cost**,
and **latency** under a configurable token profile and weighting. Use it to shortlist
before spending GEPA optimizer budget.

Offline verify: `yarn verify:compare`. UI: **Compare** mode or [`/compare`](/compare).
Methodology companion to [methodology.md](methodology.md).

## Constraints

- **No absolute currency.** Cost is always `% of baseline`. Raw provider rates live in
  `packages/harness/src/lib/compare/registry/models.json` for server-side math only —
  they are never returned by `/api/compare*`, rendered in the UI, or written to exports.
- Registry is **illustrative** (see sibling `SOURCES.md`). Not Redrob production rates,
  failure rates, or unit economics.
- Missing published fields are **not imputed**. Rows missing an axis renormalize weights
  over present axes and are marked — a 3-axis row is not comparable to a 4-axis row.
- When `qualitySource: "run"` reports **test**, `assertSplitIsolation` still applies.

## Token profile

```ts
{ uncachedInputTokens, cachedInputTokens, outputTokens, parallelSections, failureRate }
```

Default: `2000 / 0 / 1000 / 1 / 0`, labelled
`illustrative default — replace with your own trace`.

Prefer deriving from optimize-run telemetry when available. If the run exposes
`latencyP95`, prefer that over mean — fan-out waits on the slowest of N draws.

## Relative cost

```
attemptCostRaw = (uncachedIn × rateIn + cachedIn × (rateCachedIn ?? rateIn) + out × rateOut) / 1e6
acceptedCostRaw = attemptCostRaw / (1 − failureRate)
relativeCost   = acceptedCostRaw / acceptedCostRaw[baseline] × 100
```

Only `relativeCost` leaves the module. If `cachedInput` is unpublished and the profile
uses cached tokens, cost is flagged as an **upper bound** (full input rate substituted).

## Wall-clock latency (fan-out)

With `parallelSections = N`, calls fire concurrently; you wait on the slowest:

```
wallClock = TTFT + (outputTokens / N) / tokensPerSecond
```

**Not** `outputTokens / tokensPerSecond`. As N rises, TTFT stops amortizing. A high-TTFT /
high-throughput (reasoning-like) model can win at N=1 and lose at large N.

Published latency is typically a **median**. Fan-out tracks an upper percentile of N draws;
prefer observed p95 from run telemetry when you have it.

## Normalization

| Axis | Method |
|------|--------|
| Quality | Ratio to max in set × 100 |
| Preference (Arena Elo) | Expected win rate vs top Elo: `1/(1+10^((eloMax−elo)/400))`, then × 100. Elo is log-odds — do not min-max linearly. |
| Cost | Log-normalize relative % (lower is better) — linear norm collapses order-of-magnitude spreads |
| Speed | Wall-clock vs configurable `goodEnoughSeconds` ceiling (default **8s**, arbitrary) |

## Composite, sensitivity, break-even

- Presets: balanced / cost-first / quality-first / latency-first; free sliders; last weights
  persisted client-side only (`localStorage`).
- **Rank swing** across presets is shown as a column — often more decision-relevant than the
  index under one dial setting.
- **Break-even** bisects the value a missing axis would need to reach rank *k*.

## Axis correlation

Pearson **r** (and **r²**) between quality and preference across the compared set is shown
in the UI. Where the proxies diverge, the composite does unearned work.

## Pareto

Non-dominated set across (quality ↑, preference ↑, cost ↓, wall-clock ↓). Visual idiom
matches the existing Text/Evolve scatter charts (relative cost % vs quality).

## Extending the registry

Edit `packages/harness/src/lib/compare/registry/models.json`. For every rate / published /
open-weights field, add `{ field, url, retrieved }` in `sources[]`. Document provenance in
`SOURCES.md`. Re-run `yarn verify:compare`.

## API

- `GET /api/compare/registry` — public entries (**no rates**)
- `POST /api/compare` — body `{ modelIds, tokenProfile, weights, baselineModelId, qualitySource, runId?, split?, goodEnoughSeconds? }`; `?export=md` for markdown

## Fertility

Token counting / fertility for Indic workloads continues to use `@redrob/tokenizers`.
Compare does not add a second tokenizer path.
