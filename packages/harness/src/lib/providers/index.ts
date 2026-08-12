import { applyMeasuredThroughput } from '../../config/apply-measured';
import type { ProviderId } from '../../config/models';
import { anthropicAdapter } from './anthropic';
import { googleAdapter } from './google';
import { createOpenAICompatAdapter } from './openai-compat';
import { probeVllmEndpoint, vllmAdapter, type VllmProbeResult } from './vllm';
import type { CallModelParams, CallModelResult, ProviderAdapter } from './types';
import { ProviderError } from './types';

/** Patch EVAL_MODELS from MEASURED_* env on first provider load. */
applyMeasuredThroughput();

const adapters: Record<ProviderId, ProviderAdapter> = {
  openrouter: createOpenAICompatAdapter('openrouter'),
  openai: createOpenAICompatAdapter('openai'),
  together: createOpenAICompatAdapter('together'),
  fireworks: createOpenAICompatAdapter('fireworks'),
  anthropic: anthropicAdapter,
  google: googleAdapter,
  vllm: vllmAdapter,
};

export function listProviders(): {
  id: ProviderId;
  configured: boolean;
}[] {
  return (Object.keys(adapters) as ProviderId[]).map((id) => ({
    id,
    configured: adapters[id].isConfigured(),
  }));
}

export function getProvider(providerId: ProviderId): ProviderAdapter {
  const adapter = adapters[providerId];
  if (!adapter) {
    throw new ProviderError(`Unknown provider: ${providerId}`, providerId);
  }
  return adapter;
}

/**
 * Provider-agnostic model call. Reads API keys only from process.env (server).
 */
export async function callModel(
  providerId: ProviderId,
  modelId: string,
  prompt: string,
  options?: Omit<CallModelParams, 'providerId' | 'modelId' | 'prompt'>,
): Promise<CallModelResult> {
  const adapter = getProvider(providerId);
  return adapter.call({
    modelId,
    prompt,
    systemPrompt: options?.systemPrompt,
    maxTokens: options?.maxTokens,
    temperature: options?.temperature,
    images: options?.images,
    vision: options?.vision,
    extraBody: options?.extraBody,
    endpoint: options?.endpoint,
  });
}

export { ProviderError, probeVllmEndpoint };
export type { CallModelParams, CallModelResult, ProviderAdapter, VllmProbeResult };
