/**
 * Single source of truth for eval result rows that reach the UI / exports.
 *
 * Rule: every numeric row MUST carry a non-empty `caveat`. Paths that render
 * quality / cost / latency without a caveat are forbidden.
 *
 * Self-hosted relative cost (GPU-time, not API $):
 *   relativeCostWeight(m) = 100 * (tok_per_sec_L / tok_per_sec_m)
 * Large-alone throughput = 100 baseline.
 */

import type { ModelRef } from '../../config/models';
import { modelResultCaveat, resolveModelCostWeight } from '../../config/models';
import type { MetricId } from '../../config/datasets';
import type { EvalSampleResult, EvalTargetSummary } from './types';
import { mean, summarizeTarget } from './aggregate';

export interface ResultCaveatFields {
  /** Mandatory human-readable caveat (precision, n, max-model-len, date, …) */
  caveat: string;
  /** Self-hosted extras */
  precision?: string | null;
  license?: string | null;
  hfRepoId?: string | null;
  maxModelLen?: number | null;
  meanTtftMs?: number | null;
  tokensPerSec?: number | null;
  /** When relative cost used unmeasured fallback */
  costSource?: 'catalog' | 'measured-throughput' | 'unmeasured-fallback';
}

export type ReportedTargetSummary = EvalTargetSummary & ResultCaveatFields;

export function assertHasCaveat(row: { caveat?: string }, label: string): void {
  if (!row.caveat?.trim()) {
    throw new Error(`Result row missing required caveat (${label})`);
  }
}

/** Attach mandatory caveat + self-hosted metrics onto a summary. */
export function withMandatoryCaveat(
  summary: EvalTargetSummary,
  opts: {
    model?: ModelRef | null;
    sampleCount: number;
    extraCaveat?: string;
    meanTtftMs?: number | null;
    tokensPerSec?: number | null;
    costSource?: ResultCaveatFields['costSource'];
  },
): ReportedTargetSummary {
  const baseCaveat = opts.model
    ? modelResultCaveat(opts.model, opts.sampleCount)
    : `target=${summary.targetId}; n=${opts.sampleCount}`;
  const caveat = opts.extraCaveat ? `${baseCaveat}; ${opts.extraCaveat}` : baseCaveat;

  const reported: ReportedTargetSummary = {
    ...summary,
    caveat,
    precision: opts.model?.selfHosted?.precision ?? null,
    license: opts.model?.selfHosted?.license ?? null,
    hfRepoId: opts.model?.selfHosted?.hfRepoId ?? null,
    maxModelLen: opts.model?.selfHosted?.maxModelLen ?? null,
    meanTtftMs: opts.meanTtftMs ?? null,
    tokensPerSec: opts.tokensPerSec ?? null,
    costSource: opts.costSource,
  };
  assertHasCaveat(reported, summary.targetId);
  return reported;
}

/** Recompute cost weights for self-hosted models; return summaries with caveats. */
export function reportModelTarget(params: {
  model: ModelRef;
  metric: MetricId;
  sampleResults: EvalSampleResult[];
  largeBaseline: ModelRef;
  ttftBySample?: Map<string, number>;
}): ReportedTargetSummary {
  const { weight, costSource } = resolveModelCostWeight(params.model, params.largeBaseline);
  const costWeights = params.sampleResults.map(() => weight);
  const summary = summarizeTarget({
    targetId: params.model.id,
    label: params.model.label,
    kind: 'model',
    metric: params.metric,
    sampleResults: params.sampleResults,
    costWeights,
    largeBaselineWeight: resolveModelCostWeight(params.largeBaseline, params.largeBaseline).weight,
  });

  const ttfts = params.ttftBySample
    ? [...params.ttftBySample.values()].filter((n) => Number.isFinite(n))
    : [];
  const meanTtftMs = ttfts.length ? mean(ttfts) : null;

  let tokensPerSec: number | null = params.model.selfHosted?.measuredTokPerSec ?? null;
  if (tokensPerSec == null) {
    const ok = params.sampleResults.filter((r) => !r.error && r.latencyMs > 0);
    // Rough in-run estimate from latency only when output token counts unavailable
    if (ok.length > 0) {
      tokensPerSec = null;
    }
  }

  const extra: string[] = [];
  if (costSource === 'unmeasured-fallback') {
    extra.push('relative cost uses unmeasured fallback — run Benchmark on /deploy');
  }
  if (params.model.selfHosted?.precision === 'fp8') {
    extra.push('FP8 — not directly comparable to bf16 without this caveat');
  }

  return withMandatoryCaveat(summary, {
    model: params.model,
    sampleCount: params.sampleResults.length,
    extraCaveat: extra.join('; ') || undefined,
    meanTtftMs,
    tokensPerSec,
    costSource,
  });
}

/** Indic-focused dataset ids for L-candidate A/B slices. */
export const INDIC_DATASET_IDS = ['in22-gen-hi-en', 'indic-glue-iitp-mr-hi'] as const;

export function isIndicDataset(datasetId: string): boolean {
  return (INDIC_DATASET_IDS as readonly string[]).includes(datasetId);
}

export function sliceLabelForDataset(datasetId: string): string | null {
  if (datasetId === 'in22-gen-hi-en') return 'indic:IN22-Gen';
  if (datasetId === 'indic-glue-iitp-mr-hi') return 'indic:IndicGLUE';
  return null;
}

/**
 * Ensure every target in a run result has a caveat before UI/export.
 * Mutates copies — call at the boundary (API / collect done).
 */
export function ensureResultCaveats(
  targets: EvalTargetSummary[],
  opts: {
    modelsById: Map<string, ModelRef>;
    sampleCount: number;
    datasetId: string;
  },
): ReportedTargetSummary[] {
  const slice = sliceLabelForDataset(opts.datasetId);
  return targets.map((t) => {
    const existing = t as ReportedTargetSummary;
    if (existing.caveat?.trim()) {
      assertHasCaveat(existing, t.targetId);
      if (slice && !existing.caveat.includes(slice)) {
        return { ...existing, caveat: `${existing.caveat}; slice=${slice}` };
      }
      return existing;
    }
    const model = opts.modelsById.get(t.targetId) ?? null;
    return withMandatoryCaveat(t, {
      model,
      sampleCount: opts.sampleCount,
      extraCaveat: slice ? `slice=${slice}` : undefined,
    });
  });
}
