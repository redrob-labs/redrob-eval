import type { ProviderId } from '../../config/models';
import {
  type CallModelParams,
  type CallModelResult,
  type ProviderAdapter,
  ProviderError,
} from './types';

type OpenAICompatProvider = Extract<
  ProviderId,
  'openrouter' | 'openai' | 'together' | 'fireworks'
>;

const DEFAULTS: Record<
  OpenAICompatProvider,
  { envKey: string; baseUrlEnv?: string; defaultBaseUrl: string }
> = {
  openrouter: {
    envKey: 'OPENROUTER_API_KEY',
    baseUrlEnv: 'OPENROUTER_BASE_URL',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
  },
  openai: {
    envKey: 'OPENAI_API_KEY',
    baseUrlEnv: 'OPENAI_BASE_URL',
    defaultBaseUrl: 'https://api.openai.com/v1',
  },
  together: {
    envKey: 'TOGETHER_API_KEY',
    baseUrlEnv: 'TOGETHER_BASE_URL',
    defaultBaseUrl: 'https://api.together.xyz/v1',
  },
  fireworks: {
    envKey: 'FIREWORKS_API_KEY',
    baseUrlEnv: 'FIREWORKS_BASE_URL',
    defaultBaseUrl: 'https://api.fireworks.ai/inference/v1',
  },
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createOpenAICompatAdapter(
  providerId: OpenAICompatProvider,
): ProviderAdapter {
  const cfg = DEFAULTS[providerId];

  return {
    id: providerId,
    isConfigured() {
      return Boolean(process.env[cfg.envKey]?.trim());
    },
    async call(params) {
      const apiKey = process.env[cfg.envKey]?.trim();
      if (!apiKey) {
        throw new ProviderError(
          `${cfg.envKey} is not set`,
          providerId,
        );
      }

      const baseUrl =
        process.env[cfg.baseUrlEnv ?? '']?.trim() || cfg.defaultBaseUrl;
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
        max_tokens: params.maxTokens ?? 1024,
        temperature: params.temperature ?? 0,
      };
      // Pass through Qwen-VL-family pixel budgets when the provider/model honors them
      if (params.vision?.min_pixels != null) {
        body.min_pixels = params.vision.min_pixels;
      }
      if (params.vision?.max_pixels != null) {
        body.max_pixels = params.vision.max_pixels;
      }

      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      };
      if (providerId === 'openrouter') {
        headers['HTTP-Referer'] = 'http://localhost:3939';
        headers['X-Title'] = 'redrob-eval';
      }

      const maxAttempts = 3;
      let lastError: unknown;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          });

          if (res.status === 429 || res.status >= 500) {
            const retryAfter = Number(res.headers.get('retry-after') || 0);
            const backoff = retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** (attempt - 1);
            if (attempt < maxAttempts) {
              await sleep(backoff);
              continue;
            }
          }

          const json = (await res.json()) as {
            error?: { message?: string };
            choices?: {
              message?: { content?: string | null };
              finish_reason?: string | null;
            }[];
            usage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
              prompt_tokens_details?: { cached_tokens?: number };
              completion_tokens_details?: { reasoning_tokens?: number };
            };
          };

          if (!res.ok) {
            throw new ProviderError(
              json.error?.message || `HTTP ${res.status}`,
              providerId,
              res.status,
            );
          }

          const text = json.choices?.[0]?.message?.content?.trim() ?? '';
          if (!text) {
            throw new ProviderError('Empty model response', providerId);
          }

          const reasoningTokens = json.usage?.completion_tokens_details?.reasoning_tokens;
          const completionTotal = json.usage?.completion_tokens;
          let outputTokens = completionTotal;
          if (
            reasoningTokens != null &&
            completionTotal != null &&
            completionTotal >= reasoningTokens
          ) {
            outputTokens = completionTotal - reasoningTokens;
          }

          return {
            text,
            providerId,
            modelId: params.modelId,
            latencyMs: Date.now() - started,
            inputTokens: json.usage?.prompt_tokens,
            outputTokens,
            cachedInputTokens: json.usage?.prompt_tokens_details?.cached_tokens,
            reasoningTokens: reasoningTokens ?? undefined,
            finishReason: json.choices?.[0]?.finish_reason ?? undefined,
          } satisfies CallModelResult;
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
        providerId,
      );
    },
  };
}

/** Re-export for callModel typing */
export type { CallModelParams };
