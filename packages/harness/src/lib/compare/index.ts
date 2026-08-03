export type {
  AxisId,
  AxisScore,
  CompareRequest,
  CompareResult,
  ModelAxisScores,
  ModelEntry,
  ModelPublished,
  ModelRates,
  ModelSource,
  PublicModelEntry,
  QualitySource,
  RankedModel,
  TokenProfile,
  WeightPresetId,
  Weights,
} from './types';

export {
  DEFAULT_GOOD_ENOUGH_SECONDS,
  DEFAULT_WEIGHTS,
  ILLUSTRATIVE_TOKEN_PROFILE,
  WEIGHT_PRESETS,
} from './defaults';

export { assertTokenProfile, deriveTokenProfileFromRunTelemetry } from './token-profile';
export { attemptCostRaw, acceptedCostRaw, relativeCostPct } from './relative-cost';
export { wallClockSeconds } from './latency';
export {
  normalizeQuality,
  normalizePreferenceElo,
  normalizeCostLog,
  normalizeSpeed,
} from './normalize';
export {
  COMPARE_AXES,
  compositeScore,
  presentAxesFromScores,
  renormalizeWeights,
} from './composite';
export { dominates, nonDominatedSet, type ParetoPoint } from './pareto';
export { pearsonR } from './correlation';
export { rankSwing } from './sensitivity';
export { breakEvenForRank } from './break-even';
export { compareModels, rerankWithWeights } from './rank';
export { compareResultToMarkdown } from './export-md';
export {
  assertNoCurrency,
  assertNoCurrencyInValue,
  containsCurrency,
} from './assert-no-currency';
export {
  loadCompareRegistry,
  getCompareModel,
  toPublicRegistryEntry,
  listPublicCompareRegistry,
  compareRegistryPath,
} from './registry/load';
export {
  qualitiesFromEvalRun,
  qualitiesFromOptimizeReport,
  tokenProfileFromEvalBatch,
} from './from-run';
export { deriveTokenProfileFromTexts } from './from-texts';
