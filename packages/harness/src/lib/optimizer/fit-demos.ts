/**
 * Fit demos into a prompt budget using measured (or estimated) token counts.
 * Logs demos_requested vs demos_fitted — high fertility shrinks what fits.
 */
import { countTokens } from '@redrob/tokenizers';
import type { DatasetTask } from '../../config/datasets';
import { buildEvalPrompt } from '../eval/prompts';
import {
  applyScriptPolicy,
  defaultScriptBundle,
  type ScriptPolicyBundle,
} from '../script-policy';
import type { Demo } from './types';

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export interface FitDemosResult {
  demosRequested: number;
  demosFitted: number;
  demos: Demo[];
  promptTokens: number;
  measured: boolean;
  tokenizerId?: string;
}

async function tokenCount(
  modelId: string,
  text: string,
): Promise<{ tokens: number; measured: boolean; tokenizerId?: string }> {
  try {
    const r = await countTokens(modelId, text);
    return { tokens: r.tokens, measured: true, tokenizerId: r.tokenizerId };
  } catch {
    return { tokens: estimateTokens(text), measured: false };
  }
}

/**
 * Greedily keep demos in order while the full task prompt stays under maxPromptTokens.
 * When maxPromptTokens is null/undefined, all requested demos are kept.
 */
export async function fitDemosToBudget(params: {
  modelId: string;
  task: DatasetTask;
  instruction: string;
  demos: Demo[];
  demosRequested: number;
  /** Representative user input for sizing (e.g. first train example) */
  sampleInput: string;
  maxPromptTokens?: number | null;
  scriptPolicies?: ScriptPolicyBundle;
}): Promise<FitDemosResult> {
  const policies = params.scriptPolicies ?? defaultScriptBundle('passthrough');
  const instruction = applyScriptPolicy(params.instruction, policies.instruction);
  const sampleInput = applyScriptPolicy(params.sampleInput, policies.input);
  const requested = Math.max(0, params.demosRequested);
  const pool = params.demos.slice(0, requested).map((d) => ({
    input: applyScriptPolicy(d.input, policies.demos),
    output: applyScriptPolicy(d.output, policies.demos),
  }));

  const budget = params.maxPromptTokens;
  if (budget == null || budget <= 0 || pool.length === 0) {
    const prompt = buildEvalPrompt(params.task, sampleInput, {
      instruction,
      demos: pool,
    });
    const counted = await tokenCount(params.modelId, prompt);
    return {
      demosRequested: requested,
      demosFitted: pool.length,
      demos: pool,
      promptTokens: counted.tokens,
      measured: counted.measured,
      tokenizerId: counted.tokenizerId,
    };
  }

  const fitted: Demo[] = [];
  let lastTokens = 0;
  let measured = true;
  let tokenizerId: string | undefined;

  for (let i = 0; i <= pool.length; i++) {
    const trial = pool.slice(0, i);
    const prompt = buildEvalPrompt(params.task, sampleInput, {
      instruction,
      demos: trial,
    });
    const counted = await tokenCount(params.modelId, prompt);
    measured = measured && counted.measured;
    tokenizerId = counted.tokenizerId ?? tokenizerId;
    if (counted.tokens > budget) break;
    fitted.length = 0;
    fitted.push(...trial);
    lastTokens = counted.tokens;
  }

  return {
    demosRequested: requested,
    demosFitted: fitted.length,
    demos: fitted,
    promptTokens: lastTokens,
    measured,
    tokenizerId,
  };
}
