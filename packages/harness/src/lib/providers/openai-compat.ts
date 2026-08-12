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

/**
 * Ceiling on the raised budget when a reasoning model has been cut off mid-thought.
 * High enough for the reasoning models on offer, finite because the caller is paying.
 */
const MAX_REASONING_BUDGET = 16_384;

/** Room for an answer once the thinking is paid for. */
const REASONING_HEADROOM = 1024;

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
        temperature: params.temperature ?? 0,
      };
      // null = unlimited (omit); undefined = legacy default 1024
      if (params.maxTokens === null) {
        // omit max_tokens — provider/model allowed max
      } else {
        body.max_tokens = params.maxTokens ?? 1024;
      }
      // Pass through Qwen-VL-family pixel budgets when the provider/model honors them
      if (params.vision?.min_pixels != null) {
        body.min_pixels = params.vision.min_pixels;
      }
      if (params.vision?.max_pixels != null) {
        body.max_pixels = params.vision.max_pixels;
      }
      if (params.extraBody) {
        Object.assign(body, params.extraBody);
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
      /** One escalation only, so a model that never answers cannot bill us in a loop. */
      let raisedForReasoning = false;

      // The reasoning escalation below is a re-ask, not a failed attempt, so it is granted
      // an extra turn rather than eating one of the retries meant for 429s and 5xxs.
      for (
        let attempt = 1;
        attempt <= maxAttempts + (raisedForReasoning ? 1 : 0);
        attempt++
      ) {
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
          const finishReason = json.choices?.[0]?.finish_reason ?? undefined;
          const reasoningTokens = json.usage?.completion_tokens_details?.reasoning_tokens;
          const completionTotal = json.usage?.completion_tokens;

          // A reasoning model can spend the caller's whole budget thinking, and return
          // either nothing at all or an answer that stops mid-sentence. Neither is a wrong
          // answer, and neither may be scored as one: the cap was ours, and the thinking
          // it went on is not something the caller asked for or can see. Raise it and ask
          // again rather than reporting a model that never got to finish speaking.
          //
          // Gated on reasoning tokens rather than on truncation alone. A verbose ordinary
          // model hitting the cap is the cap doing its job; a reasoning model hitting it
          // is the cap being spent on something other than the answer.
          if (
            finishReason === 'length' &&
            (reasoningTokens ?? 0) > 0 &&
            !raisedForReasoning &&
            typeof body.max_tokens === 'number'
          ) {
            raisedForReasoning = true;
            body.max_tokens = Math.min(
              MAX_REASONING_BUDGET,
              Math.max(body.max_tokens * 4, (reasoningTokens ?? 0) + REASONING_HEADROOM),
            );
            continue;
          }

          if (!text) {
            // Terminal, not retried. These calls go out at temperature 0, so asking the
            // same question again returns the same nothing — and after the escalation
            // above it would do so at four times the token budget, on the caller's bill.
            lastError = new ProviderError(
              finishReason === 'length'
                ? `Model returned no answer: the reply was cut off at ${completionTotal ?? '?'} ` +
                  `tokens${(reasoningTokens ?? 0) > 0 ? `, ${reasoningTokens} of them reasoning` : ''}`
                : 'Empty model response',
              providerId,
            );
            break;
          }

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
            finishReason,
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
