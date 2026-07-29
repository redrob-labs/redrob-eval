import type { ProviderId } from '../../config/models';

/** In-memory image for one multimodal call — discarded when the call returns. */
export interface VisionImagePart {
  mimeType: string;
  /** Raw base64 without data: prefix */
  base64: string;
}

export interface VisionTokenControls {
  /** Qwen-VL-family style pixel budgets mapped from tokens_per_frame */
  min_pixels?: number;
  max_pixels?: number;
}

export interface CallModelParams {
  providerId: ProviderId;
  modelId: string;
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  /**
   * Optional vision frames for checklist / image judging.
   * Held only for this call — never write these to logs or datasets.
   */
  images?: VisionImagePart[];
  /** Provider vision token / resolution controls (e.g. min_pixels / max_pixels). */
  vision?: VisionTokenControls;
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
