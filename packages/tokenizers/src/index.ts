/**
 * Fertility measurement with the actual model tokenizer (measured, not estimated).
 * Uses @huggingface/transformers AutoTokenizer (auto-detects from tokenizer.json).
 */
import { AutoTokenizer } from '@huggingface/transformers';

type TokenizerLike = {
  encode: (text: string, options?: { add_special_tokens?: boolean }) => number[] | Promise<number[]>;
  [key: string]: unknown;
};

const cache = new Map<string, TokenizerLike>();

/** Map OpenRouter / HF model ids to a public tokenizer repo when needed. */
export function resolveTokenizerId(modelId: string): string {
  const id = modelId.replace(/^or\//, '');
  // Prefer Xenova ONNX-friendly mirrors for common families when available
  const aliases: Record<string, string> = {
    'meta-llama/llama-3.1-8b-instruct': 'Xenova/llama-3.2-1b-instruct',
    'meta-llama/llama-3.3-70b-instruct': 'Xenova/llama-3.2-1b-instruct',
    'openai/gpt-4o-mini': 'Xenova/gpt-4o',
    'openai/gpt-4o': 'Xenova/gpt-4o',
    'google/gemini-2.0-flash-001': 'Xenova/gemma-2-2b-it',
    'qwen/qwen3.7-flash': 'Xenova/Qwen2.5-0.5B',
  };
  return aliases[id] ?? id;
}

export async function loadTokenizer(modelId: string): Promise<TokenizerLike> {
  const tokenizerId = resolveTokenizerId(modelId);
  const cached = cache.get(tokenizerId);
  if (cached) return cached;
  const tok = (await AutoTokenizer.from_pretrained(tokenizerId, {
    // progress_callback omitted — keep quiet in server logs
  })) as unknown as TokenizerLike;
  cache.set(tokenizerId, tok);
  return tok;
}

export async function countTokens(
  modelId: string,
  text: string,
): Promise<{ tokens: number; tokenizerId: string; measured: true }> {
  const tokenizerId = resolveTokenizerId(modelId);
  try {
    const tok = await loadTokenizer(modelId);
    const encoded = await Promise.resolve(
      tok.encode(text, { add_special_tokens: false }),
    );
    const tokens = Array.isArray(encoded) ? encoded.length : 0;
    return { tokens: Math.max(0, tokens), tokenizerId, measured: true };
  } catch (error) {
    // Never invent a token count. Callers decide whether to estimate, and the
    // cause matters: offline, gated repo and missing tokenizer.json look alike
    // to a caller that only sees a boolean.
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load tokenizer for ${tokenizerId}: ${cause}`);
  }
}

/** Words ≈ whitespace-separated tokens (Indic-friendly enough for fertility ratios). */
export function wordCount(text: string): number {
  const parts = text.trim().split(/\s+/u).filter(Boolean);
  return parts.length || (text.trim() ? 1 : 0);
}

export interface FertilityResult {
  languageHint: string;
  tokens: number;
  words: number;
  /** tokens per word — the fertility figure */
  fertility: number;
  tokenizerId: string;
  measured: boolean;
  /** Why the real tokenizer was not used. Set only when measured is false. */
  fallbackReason?: string;
}

/**
 * Measure tokenizer fertility (tokens/word) for a text sample.
 * Always prefer the actual tokenizer of the target model.
 *
 * On failure this returns a character heuristic with `measured: false`. That
 * number is not a measurement: check the flag before reporting it.
 */
export async function measureFertility(params: {
  modelId: string;
  text: string;
  languageHint?: string;
}): Promise<FertilityResult> {
  const words = wordCount(params.text);
  try {
    const { tokens, tokenizerId, measured } = await countTokens(
      params.modelId,
      params.text,
    );
    return {
      languageHint: params.languageHint ?? 'unknown',
      tokens,
      words,
      fertility: words > 0 ? tokens / words : 0,
      tokenizerId,
      measured,
    };
  } catch (error) {
    // Character heuristic only as last resort, flagged measured:false
    const tokens = Math.max(1, Math.ceil(params.text.length / 4));
    return {
      languageHint: params.languageHint ?? 'unknown',
      tokens,
      words,
      fertility: words > 0 ? tokens / words : 0,
      tokenizerId: resolveTokenizerId(params.modelId),
      measured: false,
      fallbackReason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function measureFertilityByLanguage(params: {
  modelId: string;
  samples: Array<{ text: string; languageHint: string }>;
}): Promise<Record<string, FertilityResult>> {
  const byLang: Record<string, { tokens: number; words: number; tokenizerId: string; measured: boolean }> =
    {};
  for (const s of params.samples) {
    const r = await measureFertility({
      modelId: params.modelId,
      text: s.text,
      languageHint: s.languageHint,
    });
    const cur = byLang[s.languageHint] ?? {
      tokens: 0,
      words: 0,
      tokenizerId: r.tokenizerId,
      measured: r.measured,
    };
    cur.tokens += r.tokens;
    cur.words += r.words;
    cur.measured = cur.measured && r.measured;
    byLang[s.languageHint] = cur;
  }
  const out: Record<string, FertilityResult> = {};
  for (const [lang, agg] of Object.entries(byLang)) {
    out[lang] = {
      languageHint: lang,
      tokens: agg.tokens,
      words: agg.words,
      fertility: agg.words > 0 ? agg.tokens / agg.words : 0,
      tokenizerId: agg.tokenizerId,
      measured: agg.measured,
    };
  }
  return out;
}
