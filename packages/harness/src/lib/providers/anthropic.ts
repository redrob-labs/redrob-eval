import type { ProviderAdapter } from './types';
import { ProviderError } from './types';

/** Anthropic requires max_tokens; high ceiling when caller asks for unlimited. */
const UNLIMITED_MAX_TOKENS = 128_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const anthropicAdapter: ProviderAdapter = {
  id: 'anthropic',
  isConfigured() {
    return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
  },
  async call(params) {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) {
      throw new ProviderError('ANTHROPIC_API_KEY is not set', 'anthropic');
    }

    const started = Date.now();
    const maxAttempts = 3;
    let lastError: unknown;
    const maxTokens =
      params.maxTokens === null
        ? UNLIMITED_MAX_TOKENS
        : (params.maxTokens ?? 1024);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: params.modelId,
            max_tokens: maxTokens,
            temperature: params.temperature ?? 0,
            system: params.systemPrompt?.trim() || undefined,
            messages: [{ role: 'user', content: params.prompt }],
          }),
        });

        if (res.status === 429 || res.status >= 500) {
          if (attempt < maxAttempts) {
            await sleep(500 * 2 ** (attempt - 1));
            continue;
          }
        }

        const json = (await res.json()) as {
          error?: { message?: string };
          content?: { type: string; text?: string }[];
          stop_reason?: string | null;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
          };
        };

        if (!res.ok) {
          throw new ProviderError(
            json.error?.message || `HTTP ${res.status}`,
            'anthropic',
            res.status,
          );
        }

        const text = json.content
          ?.filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join('')
          .trim();

        if (!text) {
          throw new ProviderError('Empty model response', 'anthropic');
        }

        return {
          text,
          providerId: 'anthropic' as const,
          modelId: params.modelId,
          latencyMs: Date.now() - started,
          inputTokens: json.usage?.input_tokens,
          outputTokens: json.usage?.output_tokens,
          cachedInputTokens: json.usage?.cache_read_input_tokens,
          finishReason: json.stop_reason ?? undefined,
        };
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
      'anthropic',
    );
  },
};
