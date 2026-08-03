import type { TokenProfile } from './types';
import { ILLUSTRATIVE_TOKEN_PROFILE } from './defaults';

export function assertTokenProfile(p: TokenProfile): TokenProfile {
  if (!Number.isFinite(p.uncachedInputTokens) || p.uncachedInputTokens < 0) {
    throw new Error('uncachedInputTokens must be a finite number ≥ 0');
  }
  if (!Number.isFinite(p.cachedInputTokens) || p.cachedInputTokens < 0) {
    throw new Error('cachedInputTokens must be a finite number ≥ 0');
  }
  if (!Number.isFinite(p.outputTokens) || p.outputTokens < 0) {
    throw new Error('outputTokens must be a finite number ≥ 0');
  }
  if (!Number.isFinite(p.parallelSections) || p.parallelSections < 1) {
    throw new Error('parallelSections must be a finite number ≥ 1');
  }
  if (!Number.isFinite(p.failureRate) || p.failureRate < 0 || p.failureRate >= 1) {
    throw new Error('failureRate must be in [0, 1)');
  }
  return {
    uncachedInputTokens: p.uncachedInputTokens,
    cachedInputTokens: p.cachedInputTokens,
    outputTokens: p.outputTokens,
    parallelSections: Math.floor(p.parallelSections),
    failureRate: p.failureRate,
    label: p.label?.trim() || ILLUSTRATIVE_TOKEN_PROFILE.label,
  };
}

/**
 * Prefer observed run telemetry over typing. Use p95 latency hint in the label
 * when provided (fan-out waits on the slowest of N draws).
 */
export function deriveTokenProfileFromRunTelemetry(input: {
  meanUncachedInputTokens: number;
  meanCachedInputTokens?: number;
  meanOutputTokens: number;
  parallelSections?: number;
  failureRate?: number;
  latencyP95Seconds?: number;
}): TokenProfile {
  const parts = ['derived from run telemetry'];
  if (input.latencyP95Seconds != null && Number.isFinite(input.latencyP95Seconds)) {
    parts.push(`observed p95 latency ≈ ${input.latencyP95Seconds.toFixed(2)}s (prefer over mean)`);
  }
  return assertTokenProfile({
    uncachedInputTokens: Math.max(0, Math.round(input.meanUncachedInputTokens)),
    cachedInputTokens: Math.max(0, Math.round(input.meanCachedInputTokens ?? 0)),
    outputTokens: Math.max(0, Math.round(input.meanOutputTokens)),
    parallelSections: Math.max(1, Math.floor(input.parallelSections ?? 1)),
    failureRate: Math.min(0.999, Math.max(0, input.failureRate ?? 0)),
    label: parts.join(' — '),
  });
}
