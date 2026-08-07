/**
 * Eval model catalog — edit freely.
 * Each entry is a (provider, modelId) pair shown in the UI later.
 * Only providers with a matching env API key will be callable.
 */

import {
  SELF_HOSTED_CANDIDATES,
  SELF_HOSTED_DEFAULTS,
  SELF_HOSTED_EXCLUSIONS,
  VLLM_ENV,
  buildSelfHostedCaveat,
  relativeCostFromThroughput,
  resolveSelfHostedCostWeight,
  type SelfHostedAxis,
  type SelfHostedLicense,
  type SelfHostedMeta,
  type SelfHostedPrecision,
} from './self-hosted';

export type ProviderId =
  | 'openrouter'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'together'
  | 'fireworks'
  | 'vllm';

export interface ModelRef {
  /** Stable id used in results / routing logs */
  id: string;
  label: string;
  providerId: ProviderId;
  /** Provider-native model identifier */
  modelId: string;
  /**
   * Relative cost weight for Pareto charts (unitless).
   * Large baseline models should be ~100; smaller models lower.
   * Not a dollar price — no absolute pricing.
   * For vLLM, prefer measured tok/s via selfHosted (see resolveModelCostWeight).
   */
  relativeCostWeight: number;
  /** Hint for the complexity router (step 3) */
  tier?: 'small' | 'large';
  /** Present for self-hosted / vLLM catalog rows — required in result caveats */
  selfHosted?: SelfHostedMeta;
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  together: 'Together',
  fireworks: 'Fireworks',
  vllm: 'Self-hosted (vLLM)',
};

function selfHostedRef(
  key: keyof typeof SELF_HOSTED_CANDIDATES,
  precision: SelfHostedMeta['precision'],
  fallbackWeight: number,
): ModelRef {
  const c = SELF_HOSTED_CANDIDATES[key];
  const meta: SelfHostedMeta = {
    axis: c.axis,
    hfRepoId: c.hfRepoId,
    license: c.license,
    precision,
    maxModelLen: SELF_HOSTED_DEFAULTS.maxModelLen,
    servedModelName: c.servedModelName,
    measuredTokPerSec: null,
    measuredAt: null,
  };
  return {
    id: c.id,
    label: c.label,
    providerId: 'vllm',
    modelId: c.servedModelName,
    relativeCostWeight: fallbackWeight,
    tier: c.axis === 'S' ? 'small' : 'large',
    selfHosted: meta,
  };
}

/** Default comparison set — replace / extend for your eval. */
export const EVAL_MODELS: ModelRef[] = [
  {
    id: 'or-llama-8b',
    label: 'Llama 3.1 8B (OpenRouter)',
    providerId: 'openrouter',
    modelId: 'meta-llama/llama-3.1-8b-instruct',
    relativeCostWeight: 12,
    tier: 'small',
  },
  {
    id: 'or-llama-70b',
    label: 'Llama 3.3 70B (OpenRouter)',
    providerId: 'openrouter',
    modelId: 'meta-llama/llama-3.3-70b-instruct',
    relativeCostWeight: 55,
    tier: 'large',
  },
  {
    id: 'or-gpt-4o-mini',
    label: 'GPT-4o mini (OpenRouter)',
    providerId: 'openrouter',
    modelId: 'openai/gpt-4o-mini',
    relativeCostWeight: 20,
    tier: 'small',
  },
  {
    id: 'or-gpt-4o',
    label: 'GPT-4o (OpenRouter)',
    providerId: 'openrouter',
    modelId: 'openai/gpt-4o',
    relativeCostWeight: 100,
    tier: 'large',
  },
  {
    id: 'openai-gpt-4o-mini',
    label: 'GPT-4o mini (OpenAI)',
    providerId: 'openai',
    modelId: 'gpt-4o-mini',
    relativeCostWeight: 20,
    tier: 'small',
  },
  {
    id: 'anthropic-haiku',
    label: 'Claude Haiku 4.5 (Anthropic)',
    providerId: 'anthropic',
    modelId: 'claude-haiku-4-5-20251001',
    relativeCostWeight: 25,
    tier: 'small',
  },
  {
    id: 'google-flash',
    label: 'Gemini 2.0 Flash (Google)',
    providerId: 'google',
    modelId: 'gemini-2.0-flash',
    relativeCostWeight: 18,
    tier: 'small',
  },
  // Self-hosted defaults: axis S = Gemma 4 E4B, axis L = Gemma 4 31B
  selfHostedRef('gemma4-e4b', 'pending', 25),
  selfHostedRef('gemma4-31b', 'pending', 100),
  // Axis L swap for Indic A/B (IN22-Gen / IndicGLUE slice)
  selfHostedRef('qwen36-27b', 'pending', 100),
  // Additional L candidates (swap on /deploy; served name stays redrob-l)
  selfHostedRef('gemma4-26b-a4b', 'pending', 100),
  selfHostedRef('qwen36-35b-a3b', 'pending', 100),
  selfHostedRef('gpt-oss-120b', 'pending', 100),
];

export function getModelById(id: string): ModelRef | undefined {
  return EVAL_MODELS.find((m) => m.id === id);
}

/** List self-hosted catalog rows (providerId === vllm). */
export function listSelfHostedModels(): ModelRef[] {
  return EVAL_MODELS.filter((m) => m.providerId === 'vllm');
}

/**
 * Effective relative cost weight.
 * Self-hosted: recompute from measured tok/s when both S and L throughputs exist.
 */
export function resolveModelCostWeight(
  model: ModelRef,
  largeBaseline?: ModelRef | null,
): { weight: number; costSource: 'catalog' | 'measured-throughput' | 'unmeasured-fallback' } {
  if (!model.selfHosted) {
    return { weight: model.relativeCostWeight, costSource: 'catalog' };
  }
  const largeTok =
    largeBaseline?.selfHosted?.measuredTokPerSec ??
    EVAL_MODELS.find((m) => m.id === SELF_HOSTED_CANDIDATES['gemma4-31b'].id)?.selfHosted
      ?.measuredTokPerSec ??
    null;
  const resolved = resolveSelfHostedCostWeight({
    axis: model.selfHosted.axis,
    measuredTokPerSec: model.selfHosted.measuredTokPerSec,
    largeMeasuredTokPerSec:
      model.selfHosted.axis === 'L'
        ? model.selfHosted.measuredTokPerSec
        : largeTok,
    fallbackWeight: model.relativeCostWeight,
  });
  return {
    weight: resolved.weight,
    costSource:
      resolved.costSource === 'measured-throughput'
        ? 'measured-throughput'
        : 'unmeasured-fallback',
  };
}

export function modelResultCaveat(model: ModelRef, sampleCount: number): string {
  if (model.selfHosted) {
    return buildSelfHostedCaveat(model.selfHosted, [`n=${sampleCount}`]);
  }
  return `provider=${model.providerId}; model=${model.modelId}; n=${sampleCount}`;
}

export {
  SELF_HOSTED_CANDIDATES,
  SELF_HOSTED_DEFAULTS,
  SELF_HOSTED_EXCLUSIONS,
  VLLM_ENV,
  buildSelfHostedCaveat,
  relativeCostFromThroughput,
  resolveSelfHostedCostWeight,
  type SelfHostedAxis,
  type SelfHostedLicense,
  type SelfHostedMeta,
  type SelfHostedPrecision,
};
