/**
 * Eval model catalog — edit freely.
 * Each entry is a (provider, modelId) pair shown in the UI later.
 * Only providers with a matching env API key will be callable.
 */

import {
  SELF_HOSTED_CANDIDATES,
  SELF_HOSTED_DEFAULTS,
  SELF_HOSTED_EXCLUSIONS,
  SERVED_MODEL_NAME,
  VLLM_ENV,
  baseUrlForServedName,
  buildSelfHostedCaveat,
  relativeCostFromThroughput,
  resolveSelfHostedCostWeight,
  slotServedName,
  vllmSlotEndpoints,
  type SelfHostedLicense,
  type SelfHostedMeta,
  type SelfHostedPrecision,
  type SelfHostedTier,
  type VllmSlotEndpoint,
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

/**
 * The one self-hosted row: the endpoint itself, not a particular model.
 *
 * There is a single vLLM endpoint and Deploy puts one model behind it, so a row
 * per candidate would be several ids for one thing that can only answer as one.
 * `applyMeasuredThroughput` rewrites the label and metadata from what the host
 * reports it is serving, and the id stays put so saved runs keep resolving.
 */
export const SELF_HOSTED_ENDPOINT_ID = 'vllm-endpoint';

function selfHostedEndpointRow(): ModelRef {
  const c = SELF_HOSTED_CANDIDATES[SELF_HOSTED_DEFAULTS.model];
  const meta: SelfHostedMeta = {
    hfRepoId: c.hfRepoId,
    license: c.license,
    precision: 'pending',
    maxModelLen: SELF_HOSTED_DEFAULTS.maxModelLen,
    servedModelName: SERVED_MODEL_NAME,
    measuredTokPerSec: null,
    measuredAt: null,
  };
  return {
    id: SELF_HOSTED_ENDPOINT_ID,
    label: `Self-hosted: ${c.label.replace(' (self-hosted)', '')}`,
    providerId: 'vllm',
    modelId: SERVED_MODEL_NAME,
    relativeCostWeight: 100,
    tier: c.tier,
    selfHosted: meta,
  };
}

/** Catalog id for one deploy slot's endpoint, e.g. `vllm-endpoint-s1`. */
export function selfHostedSlotId(slot: number): string {
  return `${SELF_HOSTED_ENDPOINT_ID}-s${slot}`;
}

/**
 * Catalog row for one deploy slot, named from what that slot answered with.
 *
 * The single row above cannot represent two slots, so a second deployed model
 * was invisible in the picker. These rows are built per request from the live
 * probe rather than declared, because which slots exist is a fact about the host.
 */
export function selfHostedSlotRow(live: {
  slot: number;
  servedModelName: string;
  hfRepoId: string;
  maxModelLen: number | null;
}): ModelRef {
  const candidate = Object.values(SELF_HOSTED_CANDIDATES).find(
    (c) => c.hfRepoId === live.hfRepoId,
  );
  const shortLabel = candidate
    ? candidate.label.replace(/\s*\(self-hosted\)$/, '')
    : live.hfRepoId;
  const meta: SelfHostedMeta = {
    hfRepoId: live.hfRepoId,
    license: candidate?.license ?? 'apache-2.0',
    precision: 'pending',
    maxModelLen: live.maxModelLen ?? SELF_HOSTED_DEFAULTS.maxModelLen,
    servedModelName: live.servedModelName,
    measuredTokPerSec: null,
    measuredAt: null,
  };
  return {
    id: selfHostedSlotId(live.slot),
    label: `Self-hosted: ${shortLabel}`,
    providerId: 'vllm',
    // The served alias is the model id vLLM answers to, and it is what makes the
    // canonical id differ between slots.
    modelId: live.servedModelName,
    relativeCostWeight: 100,
    tier: candidate?.tier,
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
  selfHostedEndpointRow(),
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
 * Self-hosted: recompute from measured tok/s against a large baseline. A large
 * model is its own baseline, and with nothing to compare against the catalog
 * fallback stands rather than a ratio invented from one number.
 */
export function resolveModelCostWeight(
  model: ModelRef,
  largeBaseline?: ModelRef | null,
): { weight: number; costSource: 'catalog' | 'measured-throughput' | 'unmeasured-fallback' } {
  if (!model.selfHosted) {
    return { weight: model.relativeCostWeight, costSource: 'catalog' };
  }
  const resolved = resolveSelfHostedCostWeight({
    measuredTokPerSec: model.selfHosted.measuredTokPerSec,
    largeMeasuredTokPerSec:
      model.tier === 'large'
        ? model.selfHosted.measuredTokPerSec
        : (largeBaseline?.selfHosted?.measuredTokPerSec ?? null),
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
  SERVED_MODEL_NAME,
  VLLM_ENV,
  baseUrlForServedName,
  buildSelfHostedCaveat,
  relativeCostFromThroughput,
  resolveSelfHostedCostWeight,
  slotServedName,
  vllmSlotEndpoints,
  type VllmSlotEndpoint,
  type SelfHostedTier,
  type SelfHostedLicense,
  type SelfHostedMeta,
  type SelfHostedPrecision,
};
