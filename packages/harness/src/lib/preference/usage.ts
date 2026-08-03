import type { Generation, GenerationUsage, SectionGeneration, SectionLengthDistribution } from './types';

export function splitUsageFromProvider(raw: {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}): GenerationUsage {
  const cached = Math.max(0, Math.floor(raw.cachedInputTokens ?? 0));
  const inputTotal = Math.max(0, Math.floor(raw.inputTokens ?? 0));
  const uncached = Math.max(0, inputTotal - cached);
  const reasoning =
    raw.reasoningTokens != null && Number.isFinite(raw.reasoningTokens)
      ? Math.max(0, Math.floor(raw.reasoningTokens))
      : undefined;
  let output = Math.max(0, Math.floor(raw.outputTokens ?? 0));
  // If provider reported completion_tokens including reasoning, peel them off
  if (reasoning != null && reasoning > 0 && output >= reasoning) {
    output = output - reasoning;
  }
  const usage: GenerationUsage = {
    uncachedInputTokens: uncached,
    cachedInputTokens: cached,
    outputTokens: output,
  };
  if (reasoning != null) usage.reasoningTokens = reasoning;
  return usage;
}

export function emptyUsage(): GenerationUsage {
  return { uncachedInputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
}

export function sumUsage(parts: GenerationUsage[]): GenerationUsage {
  const out = emptyUsage();
  let reasoning = 0;
  let hasReasoning = false;
  for (const p of parts) {
    out.uncachedInputTokens += p.uncachedInputTokens;
    out.cachedInputTokens += p.cachedInputTokens;
    out.outputTokens += p.outputTokens;
    if (p.reasoningTokens != null) {
      reasoning += p.reasoningTokens;
      hasReasoning = true;
    }
  }
  if (hasReasoning) out.reasoningTokens = reasoning;
  return out;
}

/**
 * Classify verbatim finish/stop reasons that indicate a length/token cap.
 * Stored finishReason remains verbatim; this is only for truncationRate.
 */
export function isLengthTruncation(finishReason: string): boolean {
  const f = finishReason.trim().toLowerCase();
  if (!f) return false;
  return (
    f === 'length' ||
    f === 'max_tokens' ||
    f === 'max_tokens_exceeded' ||
    f === 'model_context_window_exceeded' ||
    f.includes('max_token')
  );
}

export function truncationRate(generations: Generation[]): number {
  const scored = generations.filter((g) => !g.error);
  if (scored.length === 0) return 0;
  const trunc = scored.filter((g) => isLengthTruncation(g.finishReason)).length;
  return trunc / scored.length;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}

/** ε = 5% of maxTokens or at least 1 token — "clustered just under the cap". */
export function sectionLengthStats(
  sections: SectionGeneration[],
  maxTokens: number,
): SectionLengthDistribution {
  const ok = sections.filter((s) => !s.error);
  const chars = ok.map((s) => s.output.length).sort((a, b) => a - b);
  const n = ok.length;
  const meanChars = n ? chars.reduce((a, b) => a + b, 0) / n : 0;
  const eps = Math.max(1, Math.floor(maxTokens * 0.05));
  const near = ok.filter((s) => s.usage.outputTokens >= maxTokens - eps).length;
  return {
    n,
    meanChars,
    p50Chars: percentile(chars, 0.5),
    p90Chars: percentile(chars, 0.9),
    fractionNearMaxTokens: n ? near / n : 0,
  };
}
