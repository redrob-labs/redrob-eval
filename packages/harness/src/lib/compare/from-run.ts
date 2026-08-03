import type { OptimizeReport } from '../optimizer/report';
import type { EvalBatch } from '../optimizer/types';
import type { EvalRunResult } from '../eval/types';
import { deriveTokenProfileFromRunTelemetry } from './token-profile';
import type { TokenProfile } from './types';

/**
 * Pull per-model quality scores from a text eval run (targets).
 */
export function qualitiesFromEvalRun(result: EvalRunResult): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of result.targets) {
    if (t.kind === 'model' && Number.isFinite(t.quality)) {
      out[t.targetId] = t.quality;
    }
  }
  return out;
}

/**
 * Map optimize report baseline/evolved catalog ids → val (or test) quality.
 * One model gene per candidate — useful when shortlisting after a GEPA run.
 */
export function qualitiesFromOptimizeReport(
  report: OptimizeReport,
  split: 'val' | 'test' = 'val',
): Record<string, number> {
  const out: Record<string, number> = {};
  const pick = (snap: OptimizeReport['baseline']) => {
    const batch = split === 'test' ? snap.test : snap.val;
    const catalogId = snap.candidate.model.catalogId ?? snap.candidate.model.modelId;
    if (batch && catalogId && Number.isFinite(batch.quality)) {
      out[catalogId] = batch.quality;
      out[snap.candidate.model.modelId] = batch.quality;
    }
  };
  pick(report.baseline);
  pick(report.evolved);
  return out;
}

/** Prefer p95 latency when present on an EvalBatch. */
export function tokenProfileFromEvalBatch(
  batch: EvalBatch,
  extras?: { parallelSections?: number; failureRate?: number },
): TokenProfile {
  const p95 =
    batch.latencyP95 != null && Number.isFinite(batch.latencyP95)
      ? batch.latencyP95 / 1000
      : undefined;
  return deriveTokenProfileFromRunTelemetry({
    meanUncachedInputTokens: batch.promptTokens,
    meanCachedInputTokens: 0,
    meanOutputTokens: batch.completionTokens,
    parallelSections: extras?.parallelSections,
    failureRate: extras?.failureRate,
    latencyP95Seconds: p95,
  });
}
