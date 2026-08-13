import type { ProviderId } from '../../config/models';
import { VLLM_ENV, baseUrlForServedName } from '../../config/self-hosted';
import {
  type CallModelParams,
  type CallModelResult,
  type ProviderAdapter,
  ProviderError,
} from './types';

/**
 * Self-hosted vLLM OpenAI-compatible adapter.
 * VLLM_BASE_URL is slot 0 on the GPU host, reached directly, and further deploy
 * slots sit on the next ports under the alias `redrob-s{n}`. Both are set by
 * /deploy. See deploy/README.md. Streams when possible to capture
 * time-to-first-token.
 */

function defaultBaseUrl(): string {
  return process.env[VLLM_ENV.baseUrl]?.trim() || VLLM_ENV.defaultBaseUrl;
}

/**
 * Where to send a call for one served alias.
 *
 * Slots differ only by port, so a run comparing two deployed models has to send
 * each name to its own endpoint. Sending both to VLLM_BASE_URL made the second
 * model answer as a 404 from the first slot.
 */
function baseUrlFor(modelId: string): string {
  return baseUrlForServedName(modelId) ?? defaultBaseUrl();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One row of /v1/models, with the fields that identify the actual weights. */
export interface VllmServedModel {
  /** The --served-model-name alias, e.g. `redrob`. */
  id: string;
  /**
   * vLLM `root`: the --model argument it was launched with, which for a Deploy
   * host is the Hugging Face repo id. Null when the endpoint omits it.
   */
  root: string | null;
  maxModelLen: number | null;
}

export interface VllmProbeResult {
  /** VLLM_API_KEY is present. Says nothing about the endpoint being up. */
  configured: boolean;
  /** The endpoint answered /v1/models. */
  reachable: boolean;
  baseUrl: string;
  status: number | null;
  error: string | null;
  /** Model ids the endpoint reports serving; empty when unreachable. */
  servedModels: string[];
  /** The same rows with the weights behind each alias. */
  served: VllmServedModel[];
  /**
   * Whether servedModelId is in that list. null when not asked, or when the
   * endpoint answered without a usable list.
   */
  servedModelFound: boolean | null;
  /**
   * The row matching servedModelId. The served name is an alias any model can
   * hide behind, so this is the only way to know which weights answer a call.
   */
  servedModel: VllmServedModel | null;
}

/** Node's fetch reports every transport failure as "fetch failed"; the cause has the detail. */
function describeProbeFailure(error: unknown, baseUrl: string, timeoutMs: number): string {
  if (!(error instanceof Error)) return 'probe failed';
  if (error.name === 'TimeoutError') {
    return `No response from ${baseUrl} within ${timeoutMs} ms`;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message) return cause.message;
  if (cause && typeof cause === 'object' && 'code' in cause) {
    return String((cause as { code: unknown }).code);
  }
  return error.message;
}

/**
 * Ask the endpoint whether it is actually there.
 *
 * `isConfigured()` only proves an API key is set, which is why a run against a
 * powered-off GPU used to look like a model scoring zero. This is the check to
 * gate on before spending calls.
 */
export async function probeVllmEndpoint(params?: {
  servedModelId?: string;
  timeoutMs?: number;
  /** Explicit endpoint, e.g. a registered host. Overrides VLLM_BASE_URL. */
  baseUrl?: string;
  apiKey?: string | null;
}): Promise<VllmProbeResult> {
  const baseUrl = params?.baseUrl?.trim() || defaultBaseUrl();
  const apiKey = (params?.apiKey ?? process.env[VLLM_ENV.apiKey])?.trim();

  const base: VllmProbeResult = {
    configured: Boolean(apiKey),
    reachable: false,
    baseUrl,
    status: null,
    error: null,
    servedModels: [],
    served: [],
    servedModelFound: null,
    servedModel: null,
  };

  if (!apiKey) {
    return { ...base, error: `${VLLM_ENV.apiKey} is not set` };
  }

  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(params?.timeoutMs ?? 2500),
    });
    if (!res.ok) {
      return { ...base, status: res.status, error: `HTTP ${res.status}` };
    }
    const json = (await res.json()) as {
      data?: { id?: unknown; root?: unknown; max_model_len?: unknown }[];
    };
    const served: VllmServedModel[] = (json.data ?? [])
      .filter((m): m is { id: string; root?: unknown; max_model_len?: unknown } =>
        typeof m.id === 'string' && m.id.length > 0,
      )
      .map((m) => ({
        id: m.id,
        root: typeof m.root === 'string' && m.root.trim() ? m.root.trim() : null,
        maxModelLen:
          typeof m.max_model_len === 'number' && Number.isFinite(m.max_model_len)
            ? m.max_model_len
            : null,
      }));
    const servedModels = served.map((m) => m.id);
    return {
      ...base,
      reachable: true,
      status: res.status,
      servedModels,
      served,
      servedModelFound:
        params?.servedModelId && servedModels.length > 0
          ? servedModels.includes(params.servedModelId)
          : null,
      servedModel: params?.servedModelId
        ? (served.find((m) => m.id === params.servedModelId) ?? null)
        : null,
    };
  } catch (error) {
    return { ...base, error: describeProbeFailure(error, baseUrl, params?.timeoutMs ?? 2500) };
  }
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
  let reasoning = '';
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
        choices?: {
          delta?: {
            content?: string | null;
            reasoning?: string | null;
            reasoning_content?: string | null;
          };
          finish_reason?: string | null;
        }[];
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
      // Only present when the server runs a reasoning parser. Kept whole, not
      // just counted: when the model spends the whole reply thinking and never
      // emits a separate answer, the trace is the only place the answer lives,
      // and a thinking model routinely rehearses its final JSON there.
      const thought =
        chunk.choices?.[0]?.delta?.reasoning ?? chunk.choices?.[0]?.delta?.reasoning_content;
      if (thought) {
        if (ttftMs == null) ttftMs = Date.now() - params.started;
        reasoning += thought;
      }
      const fr = chunk.choices?.[0]?.finish_reason;
      if (fr) finishReason = fr;
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
        outputTokens = chunk.usage.completion_tokens ?? outputTokens;
      }
    }
  }

  const cleaned = salvageReply(text, reasoning, finishReason);

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
      message?: {
        content?: string | null;
        reasoning?: string | null;
        reasoning_content?: string | null;
      };
      finish_reason?: string | null;
    }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  if (!res.ok) {
    throw new ProviderError(json.error?.message || `HTTP ${res.status}`, 'vllm', res.status);
  }

  const message = json.choices?.[0]?.message;
  const finishReason = json.choices?.[0]?.finish_reason ?? undefined;
  const thought = message?.reasoning ?? message?.reasoning_content ?? '';
  const text = salvageReply(message?.content ?? '', thought, finishReason);

  return {
    text,
    providerId: 'vllm',
    modelId: params.modelId,
    latencyMs: Date.now() - params.started,
    inputTokens: json.usage?.prompt_tokens,
    outputTokens: json.usage?.completion_tokens,
    finishReason,
  };
}

/**
 * The answer the caller should score, given the split reply of a reasoning model.
 *
 * A server-side reasoning parser routes the trace to `reasoning` and only the
 * text after it to `content`. When the model never emits that final answer,
 * `content` is empty and the trace is all there is. Rather than fail the call
 * and drop the trace, hand it back: a thinking model rehearses its answer
 * inside the trace, and the tool-routing and MCQ parsers both pull the last
 * answer-shaped span out of whatever text they are given. An answer in the
 * trace beats a hard error that scores as a miss and shows nothing.
 *
 * Only a reply with neither a content answer nor a trace is a real failure.
 */
export function salvageReply(
  content: string,
  reasoning: string,
  finishReason: string | undefined,
): string {
  const answer = content.trim();
  if (answer) return answer;

  const trace = reasoning.trim();
  if (trace) return trace;

  throw new ProviderError(
    finishReason === 'length' ? 'Empty response, cut off by token budget' : 'Empty model response',
    'vllm',
  );
}

export const vllmAdapter: ProviderAdapter = {
  id: 'vllm',
  isConfigured() {
    return Boolean(process.env[VLLM_ENV.apiKey]?.trim());
  },
  async call(params: Omit<CallModelParams, 'providerId'>): Promise<CallModelResult> {
    const apiKey = (params.endpoint?.apiKey ?? process.env[VLLM_ENV.apiKey])?.trim();
    if (!apiKey) {
      throw new ProviderError(`${VLLM_ENV.apiKey} is not set`, 'vllm');
    }

    const baseUrl = params.endpoint?.baseUrl?.trim() || baseUrlFor(params.modelId);
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
    for (const turn of params.history ?? []) {
      messages.push({ role: turn.role, content: turn.content });
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
    if (params.extraBody) {
      Object.assign(body, params.extraBody);
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
