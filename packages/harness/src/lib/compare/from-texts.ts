import { countTokens } from '@redrob/tokenizers';
import { assertTokenProfile } from './token-profile';
import type { TokenProfile } from './types';

/**
 * Build a token profile from sample texts using `@redrob/tokenizers`
 * (measured fertility path — no second tokenizer).
 */
export async function deriveTokenProfileFromTexts(params: {
  modelId: string;
  inputTexts: string[];
  outputTexts: string[];
  parallelSections?: number;
  failureRate?: number;
}): Promise<TokenProfile> {
  const inputs = params.inputTexts.length ? params.inputTexts : [''];
  const outputs = params.outputTexts.length ? params.outputTexts : [''];
  let inSum = 0;
  for (const t of inputs) {
    const { tokens } = await countTokens(params.modelId, t);
    inSum += tokens;
  }
  let outSum = 0;
  for (const t of outputs) {
    const { tokens } = await countTokens(params.modelId, t);
    outSum += tokens;
  }
  return assertTokenProfile({
    uncachedInputTokens: Math.round(inSum / inputs.length),
    cachedInputTokens: 0,
    outputTokens: Math.round(outSum / outputs.length),
    parallelSections: params.parallelSections ?? 1,
    failureRate: params.failureRate ?? 0,
    label: `derived via @redrob/tokenizers (${params.modelId})`,
  });
}
