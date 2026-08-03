/**
 * Multi-axis model comparison types.
 * Cost is always relative (% of baseline). Raw rates never leave compare math APIs.
 */

export type AxisId = 'quality' | 'preference' | 'cost' | 'speed';

export type WeightPresetId = 'balanced' | 'cost-first' | 'quality-first' | 'latency-first';

export type Weights = {
  quality: number;
  preference: number;
  cost: number;
  speed: number;
};

/** Matches metric convention: numeric score + diagnostic text. Missing → score null. */
export type AxisScore = {
  score: number | null;
  feedback: string;
  /** True when cost used full input rate because cache rate was unpublished. */
  upperBound?: boolean;
};

export type ModelRates = {
  /** Per 1M tokens — internal computation only; never render or export. */
  input: number;
  output: number;
  /** Undefined = provider does not publish; fall back to input and flag upper bound. */
  cachedInput?: number;
  cacheWrite?: number;
};

export type ModelPublished = {
  tokensPerSecond?: number;
  /** Seconds */
  timeToFirstToken?: number;
  arenaElo?: number;
  benchmarkComposite?: number;
};

export type ModelSource = {
  field: string;
  url: string;
  retrieved: string;
};

export type ModelEntry = {
  id: string;
  label: string;
  provider: string;
  contextWindow: number;
  rates: ModelRates;
  openWeights?: { license: string; url: string };
  published?: ModelPublished;
  sources: ModelSource[];
};

/** Public view — rates omitted so nothing key- or currency-shaped reaches the browser. */
export type PublicModelEntry = {
  id: string;
  label: string;
  provider: string;
  contextWindow: number;
  openWeights?: { license: string; url: string };
  published?: ModelPublished;
  sources: ModelSource[];
  /** Whether a published cache input rate exists (not the rate itself). */
  hasCachedInputRate: boolean;
  hasPublishedLatency: boolean;
  hasArenaElo: boolean;
  hasBenchmarkComposite: boolean;
};

export type TokenProfile = {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** 1 = single call; N = concurrent fan-out (wait on slowest). */
  parallelSections: number;
  /** 0..1 share of attempts rejected / retried. */
  failureRate: number;
  /** Human label — defaults are marked illustrative. */
  label: string;
};

export type QualitySource = 'registry' | 'run';

export type CompareRequest = {
  modelIds: string[];
  tokenProfile: TokenProfile;
  weights: Weights;
  baselineModelId: string;
  qualitySource: QualitySource;
  runId?: string;
  goodEnoughSeconds?: number;
  /** When qualitySource=run and reporting test, split isolation is enforced upstream. */
  split?: 'val' | 'test';
};

export type ModelAxisScores = {
  modelId: string;
  quality: AxisScore;
  preference: AxisScore;
  cost: AxisScore;
  speed: AxisScore;
  /** Relative cost % of baseline (100 = baseline). Null if either rate path failed. */
  relativeCostPct: number | null;
  wallClockSeconds: number | null;
  presentAxes: AxisId[];
};

export type RankedModel = {
  modelId: string;
  label: string;
  rank: number;
  composite: AxisScore;
  axes: ModelAxisScores;
  /** Weights after renormalization over axes present for this model. */
  weightsUsed: Weights;
  onParetoFrontier: boolean;
  /** max(rank) − min(rank) across weight presets. */
  rankSwing: number;
  missingAxes: AxisId[];
};

export type CompareResult = {
  baselineModelId: string;
  tokenProfile: TokenProfile;
  weights: Weights;
  goodEnoughSeconds: number;
  qualitySource: QualitySource;
  qualityAxisLabel: string;
  ranked: RankedModel[];
  correlation: {
    pearsonR: number | null;
    rSquared: number | null;
    feedback: string;
  };
  frontierModelIds: string[];
  notes: string[];
};
