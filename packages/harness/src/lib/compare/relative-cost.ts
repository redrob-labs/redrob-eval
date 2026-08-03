import type { ModelEntry, TokenProfile } from './types';

/**
 * Raw attempt cost in provider rate units per 1M tokens.
 * INTERNAL ONLY — never render, export, or return from public APIs.
 */
export function attemptCostRaw(params: {
  rates: ModelEntry['rates'];
  profile: TokenProfile;
}): { raw: number; cacheUpperBound: boolean } {
  const { rates, profile } = params;
  const cacheRate = rates.cachedInput;
  const cacheUpperBound = cacheRate === undefined && profile.cachedInputTokens > 0;
  const effectiveCache = cacheRate ?? rates.input;
  const raw =
    (profile.uncachedInputTokens * rates.input +
      profile.cachedInputTokens * effectiveCache +
      profile.outputTokens * rates.output) /
    1e6;
  return { raw, cacheUpperBound };
}

/**
 * Cost accounting for rejected attempts: acceptedCost = attempt / (1 − failureRate).
 * INTERNAL ONLY.
 */
export function acceptedCostRaw(params: {
  rates: ModelEntry['rates'];
  profile: TokenProfile;
}): { raw: number; cacheUpperBound: boolean } {
  const { raw, cacheUpperBound } = attemptCostRaw(params);
  const denom = 1 - params.profile.failureRate;
  if (denom <= 0) {
    throw new Error('failureRate must be < 1');
  }
  return { raw: raw / denom, cacheUpperBound };
}

/**
 * Relative cost as % of baseline accepted cost. Only this value may leave the module.
 */
export function relativeCostPct(params: {
  model: ModelEntry;
  baseline: ModelEntry;
  profile: TokenProfile;
}): { relativeCostPct: number; upperBound: boolean; feedback: string } {
  const modelCost = acceptedCostRaw({ rates: params.model.rates, profile: params.profile });
  const baselineCost = acceptedCostRaw({
    rates: params.baseline.rates,
    profile: params.profile,
  });
  if (!(baselineCost.raw > 0)) {
    throw new Error('Baseline accepted cost must be > 0');
  }
  const pct = (modelCost.raw / baselineCost.raw) * 100;
  const upperBound = modelCost.cacheUpperBound;
  const feedback = upperBound
    ? `Relative cost ${pct.toFixed(1)}% of baseline (upper bound: no published cache input rate; used full input rate).`
    : `Relative cost ${pct.toFixed(1)}% of baseline.`;
  return { relativeCostPct: pct, upperBound, feedback };
}
