import type { ProviderAdapter } from './types';
import { ProviderError } from './types';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const googleAdapter: ProviderAdapter = {
  id: 'google',
  isConfigured() {
    return Boolean(process.env.GOOGLE_API_KEY?.trim());
  },
  async call(params) {
    const apiKey = process.env.GOOGLE_API_KEY?.trim();
    if (!apiKey) {
      throw new ProviderError('GOOGLE_API_KEY is not set', 'google');
    }

    const started = Date.now();
    const model = encodeURIComponent(params.modelId);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const contents: { role: string; parts: { text: string }[] }[] = [];
    if (params.systemPrompt?.trim()) {
      // Gemini: fold system into first user turn for broad compatibility
      contents.push({
        role: 'user',
        parts: [
          {
            text: `${params.systemPrompt.trim()}\n\n${params.prompt}`,
          },
        ],
      });
    } else {
      contents.push({ role: 'user', parts: [{ text: params.prompt }] });
    }

    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents,
            generationConfig: {
              maxOutputTokens: params.maxTokens ?? 1024,
              temperature: params.temperature ?? 0,
            },
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
          candidates?: {
            content?: { parts?: { text?: string }[] };
          }[];
          usageMetadata?: {
            promptTokenCount?: number;
            candidatesTokenCount?: number;
          };
        };

        if (!res.ok) {
          throw new ProviderError(
            json.error?.message || `HTTP ${res.status}`,
            'google',
            res.status,
          );
        }

        const text = json.candidates?.[0]?.content?.parts
          ?.map((p) => p.text ?? '')
          .join('')
          .trim();

        if (!text) {
          throw new ProviderError('Empty model response', 'google');
        }

        return {
          text,
          providerId: 'google' as const,
          modelId: params.modelId,
          latencyMs: Date.now() - started,
          inputTokens: json.usageMetadata?.promptTokenCount,
          outputTokens: json.usageMetadata?.candidatesTokenCount,
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
      'google',
    );
  },
};
