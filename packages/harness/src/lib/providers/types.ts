import type { ProviderId } from '../../config/models';

export interface CallModelParams {
  providerId: ProviderId;
  modelId: string;
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface CallModelResult {
  text: string;
  providerId: ProviderId;
  modelId: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ProviderAdapter {
  id: ProviderId;
  /** True when the matching env API key is present */
  isConfigured(): boolean;
  call(params: Omit<CallModelParams, 'providerId'>): Promise<CallModelResult>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly providerId: ProviderId,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
