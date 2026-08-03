import type { TokenProfile, WeightPresetId, Weights } from './types';

/**
 * Neutral illustrative default — replace with your own trace.
 * Not a Redrob production profile.
 */
export const ILLUSTRATIVE_TOKEN_PROFILE: TokenProfile = {
  uncachedInputTokens: 2000,
  cachedInputTokens: 0,
  outputTokens: 1000,
  parallelSections: 1,
  failureRate: 0,
  label: 'illustrative default — replace with your own trace',
};

/**
 * Arbitrary speed ceiling: wall-clock at or below this earns full speed credit.
 * Documented as arbitrary in docs/compare.md.
 */
export const DEFAULT_GOOD_ENOUGH_SECONDS = 8;

export const WEIGHT_PRESETS: Record<WeightPresetId, Weights> = {
  balanced: { quality: 0.3, preference: 0.2, cost: 0.3, speed: 0.2 },
  'cost-first': { quality: 0.2, preference: 0.1, cost: 0.5, speed: 0.2 },
  'quality-first': { quality: 0.5, preference: 0.25, cost: 0.15, speed: 0.1 },
  'latency-first': { quality: 0.2, preference: 0.1, cost: 0.2, speed: 0.5 },
};

export const DEFAULT_WEIGHTS: Weights = WEIGHT_PRESETS.balanced;
