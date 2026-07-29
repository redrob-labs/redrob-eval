import { measureFertility, countTokens } from '@redrob/tokenizers';
import type { DatasetTask, MetricId } from '../../config/datasets';
import type { ModelRef, ProviderId } from '../../config/models';
import { buildEvalPrompt, maxTokensForTask } from '../eval/prompts';
import { llmJudgeScore, scorePair } from '../metrics';
import { callModel, ProviderError } from '../providers';
import { applyScriptPolicy } from '../script-policy';
import { fitDemosToBudget } from './fit-demos';
import type { Candidate, EvalBatch, Example, FertilitySummary } from './types';
import { resolveScriptPolicies } from './types';
import { percentile } from './gepa/fitness';

/** Coarse fallback when the model tokenizer cannot be loaded (not currency). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function languageHintForTask(task: DatasetTask, text: string): string {
  if (/[\u0900-\u097F]/.test(text)) return 'hi';
  if (task === 'math' || task === 'custom') return 'en';
  if (task === 'translation' || task === 'classification') return 'hi';
  return 'en';
}

function resolveProviderCall(model: Candidate['model']): {
  providerId: ModelRef['providerId'];
  modelId: string;
  relativeCostWeight: number;
} {
  const providerId = (model.providerId ?? 'openrouter') as ModelRef['providerId'];
  return {
    providerId,
    modelId: model.modelId,
    relativeCostWeight: model.relativeCostWeight ?? 50,
  };
}

async function measuredPromptTokens(
  modelId: string,
  text: string,
): Promise<{ tokens: number; measured: boolean }> {
  try {
    const r = await countTokens(modelId, text);
    return { tokens: r.tokens, measured: true };
  } catch {
    return { tokens: estimateTokens(text), measured: false };
  }
}

/**
 * Evaluate a candidate on examples: script_policy → fit demos → model → score+feedback.
 */
export async function evaluateCandidate(params: {
  candidate: Candidate;
  examples: Example[];
  task: DatasetTask;
  metric: MetricId;
  signal?: AbortSignal;
  /** Required when metric === 'llm_judge' */
  customGoal?: { goal: string; rubric: string };
  judge?: { providerId: ProviderId; modelId: string };
}): Promise<EvalBatch> {
  const { candidate, examples, task, metric, signal } = params;
  if (metric === 'llm_judge') {
    if (!params.customGoal?.goal.trim() || !params.customGoal?.rubric.trim()) {
      throw new Error('llm_judge requires customGoal.goal and customGoal.rubric');
    }
    if (!params.judge?.modelId) {
      throw new Error('llm_judge requires a judge model');
    }
  }

  const { providerId, modelId, relativeCostWeight } = resolveProviderCall(candidate.model);
  const maxTokens = maxTokensForTask(task);
  const policies = resolveScriptPolicies(candidate);
  const instruction = applyScriptPolicy(candidate.instruction, policies.instruction);
  const demosRequested =
    candidate.demosRequested ?? candidate.demos.length;

  const sampleInput =
    examples[0]?.input ??
    'placeholder input for demo fitting';

  const fitted = await fitDemosToBudget({
    modelId,
    task,
    instruction: candidate.instruction,
    demos: candidate.demos,
    demosRequested,
    sampleInput,
    maxPromptTokens: candidate.maxPromptTokens,
    scriptPolicies: policies,
  });

  const outcomes: EvalBatch['outcomes'] = [];
  const traces: string[] = [];
  let promptTokensSum = 0;
  let completionTokensSum = 0;
  let anyUnmeasured = !fitted.measured;
  const latencies: number[] = [];
  const fertilityAgg: Record<
    string,
    { tokens: number; words: number; measured: boolean }
  > = {};

  for (const ex of examples) {
    if (signal?.aborted) {
      const err = new Error('Stopped');
      err.name = 'AbortError';
      throw err;
    }

    const userInput = applyScriptPolicy(ex.input, policies.input);
    const taskBody = buildEvalPrompt(task, userInput, {
      instruction,
      demos: fitted.demos,
    });

    let prediction = '';
    let latencyMs = 0;
    const promptCount = await measuredPromptTokens(modelId, taskBody);
    let promptTokens = promptCount.tokens;
    let completionTokens = 0;
    let error: string | undefined;
    if (!promptCount.measured) anyUnmeasured = true;

    try {
      const result = await callModel(providerId, modelId, taskBody, {
        maxTokens,
        temperature: 0,
      });
      prediction = result.text;
      latencyMs = result.latencyMs;
      if (result.inputTokens != null) {
        promptTokens = result.inputTokens;
      }
      if (result.outputTokens != null) {
        completionTokens = result.outputTokens;
      } else {
        const outCount = await measuredPromptTokens(modelId, prediction);
        completionTokens = outCount.tokens;
        if (!outCount.measured) anyUnmeasured = true;
      }
    } catch (e) {
      error =
        e instanceof ProviderError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Model call failed';
      prediction = '';
      latencyMs = 0;
    }

    let score = 0;
    let feedback: string;
    if (error) {
      feedback = `Provider error: ${error}`;
      score = 0;
    } else if (metric === 'llm_judge') {
      const judged = await llmJudgeScore({
        goal: params.customGoal!.goal,
        rubric: params.customGoal!.rubric,
        input: userInput,
        prediction,
        judge: {
          providerId: params.judge!.providerId,
          modelId: params.judge!.modelId,
        },
      });
      score = judged.score;
      feedback = judged.feedback;
    } else {
      const scored = scorePair(metric, ex.gold, prediction);
      score = scored.score;
      feedback = scored.feedback;
    }

    const lang = languageHintForTask(task, userInput);
    try {
      const fert = await measureFertility({
        modelId,
        text: userInput,
        languageHint: lang,
      });
      const cur = fertilityAgg[lang] ?? { tokens: 0, words: 0, measured: true };
      cur.tokens += fert.tokens;
      cur.words += fert.words;
      cur.measured = cur.measured && fert.measured;
      fertilityAgg[lang] = cur;
      if (!fert.measured) anyUnmeasured = true;
    } catch {
      anyUnmeasured = true;
    }

    outcomes.push({
      exampleId: ex.id,
      score,
      feedback,
      latencyMs,
      promptTokens,
      completionTokens,
      prediction,
      prompt: taskBody,
      demosFitted: fitted.demosFitted,
    });

    traces.push(
      [
        `example=${ex.id}`,
        `score=${score}`,
        `feedback=${feedback}`,
        `demos_fitted=${fitted.demosFitted}/${demosRequested}`,
        metric === 'llm_judge' ? 'metric=llm_judge' : `gold=${ex.gold.slice(0, 200)}`,
        `prediction=${prediction.slice(0, 400)}`,
      ].join('\n'),
    );

    promptTokensSum += promptTokens;
    completionTokensSum += completionTokens;
    if (!error) latencies.push(latencyMs);
  }

  const n = outcomes.length || 1;
  const quality = outcomes.reduce((s, o) => s + o.score, 0) / outcomes.length || 0;
  const sortedLat = [...latencies].sort((a, b) => a - b);

  const fertilityByLanguage: Record<string, FertilitySummary> = {};
  for (const [lang, agg] of Object.entries(fertilityAgg)) {
    fertilityByLanguage[lang] = {
      languageHint: lang,
      tokens: agg.tokens,
      words: agg.words,
      fertility: agg.words > 0 ? agg.tokens / agg.words : 0,
      measured: agg.measured,
    };
  }

  return {
    quality,
    meanRelativeCost: relativeCostWeight,
    promptTokens: Math.round(promptTokensSum / n),
    completionTokens: Math.round(completionTokensSum / n),
    totalTokens: Math.round((promptTokensSum + completionTokensSum) / n),
    latencyP50: percentile(sortedLat, 50),
    latencyP95: percentile(sortedLat, 95),
    tokensMeasured: !anyUnmeasured,
    demosRequested,
    demosFitted: fitted.demosFitted,
    fertilityByLanguage,
    outcomes,
    traces,
  };
}
