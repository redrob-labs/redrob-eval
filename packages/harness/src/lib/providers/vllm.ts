import type { ProviderId } from '../../config/models';
import { VLLM_ENV, type SelfHostedAxis } from '../../config/self-hosted';
import {
  type CallModelParams,
  type CallModelResult,
  type ProviderAdapter,
  ProviderError,
} from './types';

/**
 * Self-hosted vLLM OpenAI-compatible adapter.
 * Dual endpoints: VLLM_S_BASE_URL / VLLM_L_BASE_URL (SSH tunnel to 127.0.0.1).
 * Served names: redrob-s / redrob-l (set by /deploy, see deploy/README.md).
 * Streams when possible to capture time-to-first-token.
 */

const SERVED_AXIS: Record<string, SelfHostedAxis> = {
  'redrob-s': 'S',
  'redrob-l': 'L',
};

function axisForModel(modelId: string): SelfHostedAxis {
  return SERVED_AXIS[modelId] ?? (modelId.includes('-s') ? 'S' : 'L');
}

function baseUrlForAxis(axis: SelfHostedAxis): string {
  if (axis === 'S') {
    return (
      process.env[VLLM_ENV.baseUrlS]?.trim() || VLLM_ENV.defaultBaseUrlS
    );
  }
  return process.env[VLLM_ENV.baseUrlL]?.trim() || VLLM_ENV.defaultBaseUrlL;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callStreaming(params: {
  baseUrl: string;
  apiKey: string;
  body: Record<string, unknown>;
  modelId: string;
  started: number;
}): Promise<CallModelResult> {
  const res = await fetch(`${params.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ...params.body, stream: true, stream_options: { include_usage: true } }),
  });

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const json = (await res.json()) as { error?: { message?: string } };
      message = json.error?.message || message;
    } catch {
      /* ignore */
    }
    throw new ProviderError(message, 'vllm', res.status);
  }

  if (!res.body) {
    throw new ProviderError('Empty stream body', 'vllm');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let ttftMs: number | undefined;
  let finishReason: string | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      let chunk: {
        choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      try {
        chunk = JSON.parse(payload) as typeof chunk;
      } catch {
        continue;
      }
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        if (ttftMs == null) ttftMs = Date.now() - params.started;
        text += delta;
      }
      const fr = chunk.choices?.[0]?.finish_reason;
      if (fr) finishReason = fr;
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
        outputTokens = chunk.usage.completion_tokens ?? outputTokens;
      }
    }
  }

  const cleaned = text.trim();
  if (!cleaned) {
    throw new ProviderError('Empty model response', 'vllm');
  }

  return {
    text: cleaned,
    providerId: 'vllm',
    modelId: params.modelId,
    latencyMs: Date.now() - params.started,
    inputTokens,
    outputTokens,
    finishReason,
    timeToFirstTokenMs: ttftMs,
  };
}

async function callNonStreaming(params: {
  baseUrl: string;
  apiKey: string;
  body: Record<string, unknown>;
  modelId: string;
  started: number;
}): Promise<CallModelResult> {
  const res = await fetch(`${params.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params.body),
  });

  const json = (await res.json()) as {
    error?: { message?: string };
    choices?: {
      message?: { content?: string | null };
      finish_reason?: string | null;
    }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  if (!res.ok) {
    throw new ProviderError(json.error?.message || `HTTP ${res.status}`, 'vllm', res.status);
  }

  const text = json.choices?.[0]?.message?.content?.trim() ?? '';
  if (!text) {
    throw new ProviderError('Empty model response', 'vllm');
  }

  return {
    text,
    providerId: 'vllm',
    modelId: params.modelId,
    latencyMs: Date.now() - params.started,
    inputTokens: json.usage?.prompt_tokens,
    outputTokens: json.usage?.completion_tokens,
    finishReason: json.choices?.[0]?.finish_reason ?? undefined,
  };
}

export const vllmAdapter: ProviderAdapter = {
  id: 'vllm',
  isConfigured() {
    return Boolean(process.env[VLLM_ENV.apiKey]?.trim());
  },
  async call(params: Omit<CallModelParams, 'providerId'>): Promise<CallModelResult> {
    const apiKey = process.env[VLLM_ENV.apiKey]?.trim();
    if (!apiKey) {
      throw new ProviderError(`${VLLM_ENV.apiKey} is not set`, 'vllm');
    }

    const axis = axisForModel(params.modelId);
    const baseUrl = baseUrlForAxis(axis);
    const started = Date.now();

    type ContentPart =
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } };

    const userContent: string | ContentPart[] =
      params.images && params.images.length > 0
        ? [
            { type: 'text', text: params.prompt },
            ...params.images.map((img) => ({
              type: 'image_url' as const,
              image_url: {
                url: `data:${img.mimeType};base64,${img.base64}`,
              },
            })),
          ]
        : params.prompt;

    const messages: { role: string; content: string | ContentPart[] }[] = [];
    if (params.systemPrompt?.trim()) {
      messages.push({ role: 'system', content: params.systemPrompt.trim() });
    }
    messages.push({ role: 'user', content: userContent });

    const body: Record<string, unknown> = {
      model: params.modelId,
      messages,
      temperature: params.temperature ?? 0,
    };
    if (params.maxTokens === null) {
      // omit
    } else {
      body.max_tokens = params.maxTokens ?? 1024;
    }

    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        try {
          return await callStreaming({
            baseUrl,
            apiKey,
            body,
            modelId: params.modelId,
            started,
          });
        } catch (streamErr) {
          // Fall back to non-streaming if stream unsupported
          if (
            streamErr instanceof ProviderError &&
            streamErr.status &&
            streamErr.status < 500 &&
            streamErr.status !== 429
          ) {
            return await callNonStreaming({
              baseUrl,
              apiKey,
              body,
              modelId: params.modelId,
              started,
            });
          }
          throw streamErr;
        }
      } catch (error) {
        lastError = error;
        if (error instanceof ProviderError && error.status && error.status < 500 && error.status !== 429) {
          throw error;
        }
        if (attempt < maxAttempts) {
          await sleep(500 * 2 ** (attempt - 1));
          continue;
        }
      }
    }

    if (lastError instanceof ProviderError) throw lastError;
    throw new ProviderError(
      lastError instanceof Error ? lastError.message : 'Request failed',
      'vllm',
    );
  },
};

export type { ProviderId };
