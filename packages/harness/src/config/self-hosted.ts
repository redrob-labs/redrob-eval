/**
 * Self-hosted (vLLM) catalog metadata.
 *
 * Relative cost formula (also in deploy/README.md and results.ts):
 *   relativeCostWeight(m) = 100 * (tok_per_sec_L / tok_per_sec_m)
 * Large-alone throughput defines the 100 baseline (GPU-time per token).
 * Do not hardcode absolute $/hour. Weights below stay at the L=100
 * definition until the Benchmark step on /deploy measures tok/s;
 * then resolveSelfHostedCostWeight() recomputes S from the ratio.
 */

export type SelfHostedAxis = 'S' | 'L';

export type SelfHostedPrecision = 'bf16' | 'fp8' | 'mxfp4' | 'pending';

export type SelfHostedLicense = 'apache-2.0' | 'mit';

export interface SelfHostedMeta {
  axis: SelfHostedAxis;
  /** Hugging Face repo id verified at catalog time */
  hfRepoId: string;
  /** Exact license string from the model card `license` field */
  license: SelfHostedLicense;
  /** Serving precision; FP8 must be called out in every result caveat */
  precision: SelfHostedPrecision;
  /** vLLM --max-model-len (not the model native 256K) */
  maxModelLen: number;
  /** vLLM --served-model-name (stable Eval id independent of HF path) */
  servedModelName: string;
  /**
   * Measured output tok/s from the Benchmark step on /deploy.
   * null until measured — relative cost must not pretend to be final.
   */
  measuredTokPerSec: number | null;
  /** ISO date of last throughput / memory measurement, if any */
  measuredAt: string | null;
}

/** Env: VLLM_API_KEY required. Dual endpoints via axis-specific base URLs. */
export const VLLM_ENV = {
  apiKey: 'VLLM_API_KEY',
  baseUrlS: 'VLLM_S_BASE_URL',
  baseUrlL: 'VLLM_L_BASE_URL',
  defaultBaseUrlS: 'http://127.0.0.1:8101/v1',
  defaultBaseUrlL: 'http://127.0.0.1:8102/v1',
} as const;

/**
 * Candidates verified on Hugging Face (license field read from card).
 * Exclusions documented — do not add unverified ids.
 */
export const SELF_HOSTED_CANDIDATES = {
  /** Default axis S */
  'gemma4-e4b': {
    id: 'vllm-gemma4-e4b',
    label: 'Gemma 4 E4B (self-hosted)',
    hfRepoId: 'google/gemma-4-E4B-it',
    license: 'apache-2.0' as const,
    axis: 'S' as const,
    servedModelName: 'redrob-s',
    notes: 'Default small; Office/Floor local-inference candidate.',
  },
  /** Default axis L */
  'gemma4-31b': {
    id: 'vllm-gemma4-31b',
    label: 'Gemma 4 31B (self-hosted)',
    hfRepoId: 'google/gemma-4-31B-it',
    license: 'apache-2.0' as const,
    axis: 'L' as const,
    servedModelName: 'redrob-l',
    notes: 'Default large dense on single 96GB card.',
  },
  /** Axis L swap candidate (Indic-focused A/B) */
  'qwen36-27b': {
    id: 'vllm-qwen36-27b',
    label: 'Qwen3.6 27B (self-hosted)',
    hfRepoId: 'Qwen/Qwen3.6-27B',
    license: 'apache-2.0' as const,
    axis: 'L' as const,
    servedModelName: 'redrob-l',
    notes: 'Registered L swap for Gemma 4 31B vs Qwen3.6 27B Indic comparison.',
  },
  'gemma4-26b-a4b': {
    id: 'vllm-gemma4-26b-a4b',
    label: 'Gemma 4 26B A4B MoE (self-hosted)',
    hfRepoId: 'google/gemma-4-26B-A4B-it',
    license: 'apache-2.0' as const,
    axis: 'L' as const,
    servedModelName: 'redrob-l',
    notes: 'MoE alternate; HF id is A4B (not A3.8B).',
  },
  'qwen36-35b-a3b': {
    id: 'vllm-qwen36-35b-a3b',
    label: 'Qwen3.6 35B-A3B (self-hosted)',
    hfRepoId: 'Qwen/Qwen3.6-35B-A3B',
    license: 'apache-2.0' as const,
    axis: 'L' as const,
    servedModelName: 'redrob-l',
    notes: 'MoE alternate L candidate.',
  },
  'gpt-oss-120b': {
    id: 'vllm-gpt-oss-120b',
    label: 'gpt-oss-120b (self-hosted)',
    hfRepoId: 'openai/gpt-oss-120b',
    license: 'apache-2.0' as const,
    axis: 'L' as const,
    servedModelName: 'redrob-l',
    notes: 'L-only candidate; dual-load with S may not fit 96GB — measure first.',
  },
} as const;

/**
 * Excluded after verification attempt:
 * - Qwen3.6 "small": no HF repo in the Qwen3.6 family (only 27B / 35B-A3B).
 * - microsoft/phi-4 (mit): excluded from Eval catalog — training blend includes
 *   synthetic data associated with commercial-API-output distillation risk
 *   (hard constraint: no models trained on commercial API outputs).
 */
export const SELF_HOSTED_EXCLUSIONS = [
  {
    requested: 'Qwen3.6 small',
    reason: 'No Hugging Face repo in Qwen3.6 family at small scale; only 27B and 35B-A3B verified.',
  },
  {
    requested: 'microsoft/phi-4',
    reason:
      'MIT license verified, but excluded under commercial-API-output training ban (synthetic distillation risk).',
  },
] as const;

/** Default pair for routing S/L on self-hosted hardware. */
export const SELF_HOSTED_DEFAULTS = {
  axisS: 'gemma4-e4b' as const,
  axisL: 'gemma4-31b' as const,
  /** Eval-oriented context cap — not native 256K (KV would dominate VRAM). */
  maxModelLen: 8192,
};

/**
 * Large alone = 100.
 * weight(m) = 100 * (tok/s_L / tok/s_m)
 */
export function relativeCostFromThroughput(params: {
  modelTokPerSec: number;
  largeTokPerSec: number;
}): number {
  if (params.modelTokPerSec <= 0 || params.largeTokPerSec <= 0) {
    throw new Error('tok/s must be positive for relative cost');
  }
  return (100 * params.largeTokPerSec) / params.modelTokPerSec;
}

export function resolveSelfHostedCostWeight(params: {
  axis: SelfHostedAxis;
  measuredTokPerSec: number | null;
  largeMeasuredTokPerSec: number | null;
  /** Fallback only when throughput unmeasured — must be flagged in caveat */
  fallbackWeight: number;
}): { weight: number; costSource: 'measured-throughput' | 'unmeasured-fallback' } {
  if (
    params.measuredTokPerSec != null &&
    params.measuredTokPerSec > 0 &&
    params.largeMeasuredTokPerSec != null &&
    params.largeMeasuredTokPerSec > 0
  ) {
    return {
      weight: relativeCostFromThroughput({
        modelTokPerSec: params.measuredTokPerSec,
        largeTokPerSec: params.largeMeasuredTokPerSec,
      }),
      costSource: 'measured-throughput',
    };
  }
  return { weight: params.fallbackWeight, costSource: 'unmeasured-fallback' };
}

export function buildSelfHostedCaveat(meta: SelfHostedMeta, extra?: string[]): string {
  const parts = [
    `precision=${meta.precision}`,
    `license=${meta.license}`,
    `hf=${meta.hfRepoId}`,
    `maxModelLen=${meta.maxModelLen}`,
    meta.measuredAt ? `measuredAt=${meta.measuredAt}` : 'measuredAt=pending',
    meta.measuredTokPerSec != null
      ? `tok/s=${meta.measuredTokPerSec}`
      : 'tok/s=unmeasured (relative cost is fallback until the Benchmark step runs)',
  ];
  if (meta.precision === 'fp8') {
    parts.push('CAVEAT: FP8 quantization — do not compare to bf16 rows without this note');
  }
  if (extra?.length) parts.push(...extra);
  return parts.join('; ');
}
