import { measureFertility, countTokens } from '@redrob/tokenizers';
import type { DatasetTask, MetricId } from '../../config/datasets';
import type { ModelRef, ProviderId } from '../../config/models';
import { buildEvalPrompt, maxTokensForTask } from '../eval/prompts';
import {
  defaultFramePolicy,
  fitFramesToBudget,
  type FramePolicy,
} from '../frame-policy';
import { llmJudgeScore, scorePair, scorePairs, isAbstention } from '../metrics';
import { callModel, ProviderError } from '../providers';
import { applyScriptPolicy } from '../script-policy';
import {
  appendAnchorBlock,
  type ReferenceAnchor,
} from './custom-goal';
import { fitDemosToBudget } from './fit-demos';
import type { Candidate, EvalBatch, Example, FertilitySummary } from './types';
import { resolveFramePolicy, resolveScriptPolicies } from './types';
import { percentile } from './gepa/fitness';
import {
  frameBuffersFromPaths,
  loadFrameImages,
  parseFrameSetInput,
} from '../vision/frames';
import {
  buildPairwiseVisionContent,
  splitVisionContent,
} from '../vision/pairwise';

/** Coarse fallback when the model tokenizer cannot be loaded (not currency). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function languageHintForTask(task: DatasetTask, text: string): string {
  if (/[\u0900-\u097F]/.test(text)) return 'hi';
  if (task === 'math' || task === 'custom' || task === 'checklist') return 'en';
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

const BATCH_AGREEMENT_METRICS: MetricId[] = [
  'qwk',
  'cohens_kappa',
  'checklist_composite',
];

/**
 * Evaluate a candidate on examples: script_policy → fit demos → (frame_policy) → model → score+feedback.
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
  /** Fixed checklist anchors — appended at prompt time, not evolved away */
  referenceAnchors?: ReferenceAnchor[];
  /** Soft visual-token budget override for frame fitting */
  maxVisualTokens?: number | null;
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
  const baseInstruction = applyScriptPolicy(candidate.instruction, policies.instruction);
  const instruction = appendAnchorBlock(baseInstruction, params.referenceAnchors);
  const demosRequested =
    candidate.demosRequested ?? candidate.demos.length;

  const framePolicy: FramePolicy | undefined =
    candidate.framePolicy || task === 'checklist'
      ? defaultFramePolicy(candidate.framePolicy ?? resolveFramePolicy(candidate))
      : undefined;

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

  let framesRequested = 0;
  let framesFitted = 0;

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
  let abstainedCount = 0;

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
    let exampleFramesFitted: number | undefined;
    if (!promptCount.measured) anyUnmeasured = true;

    // Ephemeral vision payload — scoped to this iteration only
    let visionImages: Awaited<ReturnType<typeof loadFrameImages>>['images'] | undefined;
    let visionControls: { min_pixels: number; max_pixels: number } | undefined;

    try {
      const frameRef = task === 'checklist' ? parseFrameSetInput(userInput) : null;
      if (framePolicy && frameRef) {
        const stubs = frameBuffersFromPaths(frameRef.framePaths);
        const fittedFrames = fitFramesToBudget({
          policy: framePolicy,
          frames: stubs,
          maxVisualTokens: params.maxVisualTokens,
        });
        framesRequested = fittedFrames.framesRequested;
        framesFitted = fittedFrames.framesFitted;
        exampleFramesFitted = fittedFrames.framesFitted;
        visionControls = fittedFrames.vision;

        // Load only selected frames into memory, score, then drop references
        const loaded = await loadFrameImages(frameRef.framePaths, fittedFrames.indices);
        visionImages = loaded.images;

        // Relative judgment vs anchors when present (reuse pairwise packing)
        let prompt = taskBody;
        let images = visionImages;
        if (params.referenceAnchors && params.referenceAnchors.length > 0) {
          const anchorGroups: Array<{
            label: string;
            images: typeof visionImages;
          }> = [];
          for (const a of params.referenceAnchors) {
            const idxs = a.framePaths.map((_, i) => i);
            const al = await loadFrameImages(a.framePaths, idxs.slice(0, 4));
            anchorGroups.push({ label: `Anchor:${a.label}`, images: al.images });
          }
          const packed = buildPairwiseVisionContent({
            preamble: taskBody,
            groups: [
              ...anchorGroups,
              { label: 'Candidate clip', images: visionImages },
            ],
            closing:
              'Judge the candidate clip relative to the anchors. Return checklist JSON or ABSTAIN.',
          });
          const split = splitVisionContent(packed);
          prompt = split.prompt;
          images = split.images;
        }

        const result = await callModel(providerId, modelId, prompt, {
          maxTokens,
          temperature: 0,
          images,
          vision: visionControls,
        });
        prediction = result.text;
        latencyMs = result.latencyMs;
        if (result.inputTokens != null) promptTokens = result.inputTokens;
        if (result.outputTokens != null) {
          completionTokens = result.outputTokens;
        } else {
          const outCount = await measuredPromptTokens(modelId, prediction);
          completionTokens = outCount.tokens;
          if (!outCount.measured) anyUnmeasured = true;
        }
        // Drop frame bytes — do not retain beyond this call
        visionImages = undefined;
        images = [];
      } else {
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
      visionImages = undefined;
    }

    const abstained = isAbstention(prediction);
    if (abstained) abstainedCount += 1;

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
    } else if (metric === 'abstention_rate') {
      const scored = scorePair(metric, ex.gold, prediction);
      score = scored.score;
      feedback = scored.feedback;
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
      framesFitted: exampleFramesFitted,
      abstained,
    });

    traces.push(
      [
        `example=${ex.id}`,
        `score=${score}`,
        `feedback=${feedback}`,
        `demos_fitted=${fitted.demosFitted}/${demosRequested}`,
        framePolicy
          ? `frames_fitted=${exampleFramesFitted ?? 0}/${framesRequested}`
          : '',
        abstained ? 'abstained=1' : '',
        metric === 'llm_judge' ? 'metric=llm_judge' : `gold=${ex.gold.slice(0, 200)}`,
        `prediction=${prediction.slice(0, 400)}`,
      ]
        .filter(Boolean)
        .join('\n'),
    );

    promptTokensSum += promptTokens;
    completionTokensSum += completionTokens;
    if (!error) latencies.push(latencyMs);
  }

  const n = outcomes.length || 1;
  let quality = outcomes.reduce((s, o) => s + o.score, 0) / outcomes.length || 0;

  // Batch agreement metrics: recompute quality from all predictions (abstentions excluded inside QWK)
  if (BATCH_AGREEMENT_METRICS.includes(metric) && outcomes.length > 0) {
    const pairs = outcomes.map((o, i) => ({
      gold: examples[i]?.gold ?? '',
      prediction: o.prediction ?? '',
    }));
    const batch = scorePairs(metric, pairs);
    quality = batch.score;
    if (outcomes[0]) {
      traces.push(`batch_metric=${metric} score=${batch.score} feedback=${batch.feedback}`);
    }
  }

  const sortedLat = [...latencies].sort((a, b) => a - b);
  const abstentionRate = outcomes.length > 0 ? abstainedCount / outcomes.length : 0;

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
    framesRequested: framePolicy ? framesRequested : undefined,
    framesFitted: framePolicy ? framesFitted : undefined,
    abstentionRate,
    fertilityByLanguage,
    outcomes,
    traces,
  };
}
