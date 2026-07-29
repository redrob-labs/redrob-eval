/**
 * Eval model catalog — edit freely.
 * Each entry is a (provider, modelId) pair shown in the UI later.
 * Only providers with a matching env API key will be callable.
 */

export type ProviderId =
  | 'openrouter'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'together'
  | 'fireworks';

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
   */
  relativeCostWeight: number;
  /** Hint for the complexity router (step 3) */
  tier?: 'small' | 'large';
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  together: 'Together',
  fireworks: 'Fireworks',
};

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
];

export function getModelById(id: string): ModelRef | undefined {
  return EVAL_MODELS.find((m) => m.id === id);
}
