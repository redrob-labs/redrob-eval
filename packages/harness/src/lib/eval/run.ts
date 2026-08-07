import { getDatasetById, type DatasetRef, type MetricId } from '../../config/datasets';
import type { ModelRef } from '../../config/models';
import { resolveModelCostWeight } from '../../config/models';
import { resolveEvalModel, resolveEvalModels } from '../catalog/resolve';
import { loadDataset } from '../datasets/index';
import type { EvalSample } from '../datasets/types';
import { scorePair } from '../metrics/index';
import { callModel, ProviderError } from '../providers/index';
import { routeSample, type RouteDecision } from '../router/index';
import { enrichSummaries, pickLargeBaseline, summarizeTarget } from './aggregate';
import { buildEvalPrompt, maxTokensForTask } from './prompts';
import { ensureResultCaveats, withMandatoryCaveat } from './results';
import {
  ROUTER_TARGET_ID,
  type EvalRunResult,
  type EvalSampleResult,
  type EvalStreamEvent,
  type EvalTargetSummary,
} from './types';

/** One ad-hoc prompt supplied by the user instead of a catalog dataset. */
export interface CustomPrompt {
  id?: string;
  input: string;
  /** Reference answer. Without it the prompt is generated but not scored. */
  gold?: string;
}

export const CUSTOM_DATASET_ID = 'custom';

export interface EvalRunRequest {
  /** Catalog dataset id. Optional when `prompts` is supplied. */
  datasetId?: string;
  /** Ad-hoc prompt set; takes precedence over `datasetId`. */
  prompts?: CustomPrompt[];
  /** Display name for an ad-hoc prompt set. */
  promptSetLabel?: string;
  /** Metric for ad-hoc prompts that carry gold answers. Defaults to chrF. */
  promptMetric?: MetricId;
  sampleCount: number;
  modelIds: string[];
  includeRouter?: boolean;
  /** Small model for the router pair */
  routerSmallId?: string;
  /** Large model for the router pair (also used as cost/quality baseline when present) */
  routerLargeId?: string;
  /** Explicit large baseline for relative cost % (defaults to heaviest large in selection) */
  largeBaselineId?: string;
}

/** Wrap ad-hoc prompts in the DatasetRef shape the rest of the run expects. */
function customDatasetRef(req: EvalRunRequest, metric: MetricId, count: number): DatasetRef {
  return {
    id: CUSTOM_DATASET_ID,
    label: req.promptSetLabel?.trim() || 'Custom prompts',
    task: 'custom',
    metric,
    hf: { dataset: 'custom', config: 'inline', split: 'none' },
    fields: { input: 'input', gold: 'gold' },
    maxSamples: Math.max(1, count),
    seed: 0,
  };
}

async function evalOneSample(params: {
  model: ModelRef;
  prompt: string;
  gold: string;
  metric: MetricId;
  maxTokens: number;
  sampleId: string;
  route?: RouteDecision;
  /** When false there is no gold answer, so we generate without scoring. */
  scored: boolean;
}): Promise<EvalSampleResult & { timeToFirstTokenMs?: number }> {
  try {
    const result = await callModel(params.model.providerId, params.model.modelId, params.prompt, {
      maxTokens: params.maxTokens,
      temperature: 0,
    });
    const score = params.scored ? scorePair(params.metric, params.gold, result.text).score : 0;
    return {
      sampleId: params.sampleId,
      score,
      latencyMs: result.latencyMs,
      prediction: result.text,
      route: params.route,
      timeToFirstTokenMs: result.timeToFirstTokenMs,
    };
  } catch (error) {
    const message =
      error instanceof ProviderError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Model call failed';
    return {
      sampleId: params.sampleId,
      score: 0,
      latencyMs: 0,
      prediction: '',
      error: message,
      route: params.route,
    };
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('Stopped');
    err.name = 'AbortError';
    throw err;
  }
}

function meanTtftMs(
  results: Array<EvalSampleResult & { timeToFirstTokenMs?: number }>,
): number | null {
  const vals = results
    .map((r) => r.timeToFirstTokenMs)
    .filter((n): n is number => n != null && Number.isFinite(n));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * Run a full eval, yielding SSE-friendly events.
 */
export async function* runEval(
  req: EvalRunRequest,
  opts?: { signal?: AbortSignal },
): AsyncGenerator<EvalStreamEvent, void, unknown> {
  const signal = opts?.signal;

  const customPrompts = (req.prompts ?? []).filter((p) => p.input?.trim());
  const useCustomPrompts = customPrompts.length > 0;

  // Custom prompts are only scored when the user supplied reference answers;
  // otherwise Compare ranks them through the preference bracket instead.
  const scored = useCustomPrompts ? customPrompts.every((p) => Boolean(p.gold?.trim())) : true;

  const datasetRef = useCustomPrompts
    ? customDatasetRef(req, req.promptMetric ?? 'chrf', customPrompts.length)
    : getDatasetById(req.datasetId ?? '');
  if (!datasetRef) {
    yield { type: 'error', message: `Unknown dataset id: ${req.datasetId}` };
    return;
  }

  const sampleCount = Math.min(
    Math.max(1, Math.floor(req.sampleCount)),
    datasetRef.maxSamples,
  );
  if (!req.modelIds.length && !req.includeRouter) {
    yield { type: 'error', message: 'Select at least one model or enable the router' };
    return;
  }

  let models: ModelRef[] = [];
  try {
    models = await resolveEvalModels(req.modelIds);
  } catch (e) {
    yield { type: 'error', message: e instanceof Error ? e.message : 'Bad model ids' };
    return;
  }

  let routerSmall: ModelRef | null = null;
  let routerLarge: ModelRef | null = null;
  if (req.includeRouter) {
    routerSmall =
      (await resolveEvalModel(req.routerSmallId ?? '')) ??
      models.find((m) => m.tier === 'small') ??
      models.slice().sort((a, b) => a.relativeCostWeight - b.relativeCostWeight)[0] ??
      null;
    routerLarge =
      (await resolveEvalModel(req.routerLargeId ?? '')) ??
      models.find((m) => m.tier === 'large') ??
      models.slice().sort((a, b) => b.relativeCostWeight - a.relativeCostWeight)[0] ??
      null;
    if (!routerSmall || !routerLarge) {
      yield {
        type: 'error',
        message: 'Router needs both a small and a large model id (routerSmallId / routerLargeId)',
      };
      return;
    }
    if (routerSmall.id === routerLarge.id) {
      yield { type: 'error', message: 'Router small and large models must differ' };
      return;
    }
  }

  const baselinePool = [
    ...models,
    ...(routerLarge ? [routerLarge] : []),
    ...(routerSmall ? [routerSmall] : []),
  ];
  const uniquePool = Array.from(new Map(baselinePool.map((m) => [m.id, m])).values());
  const largeBaseline =
    pickLargeBaseline(uniquePool, req.largeBaselineId ?? routerLarge?.id ?? null) ??
    uniquePool[0]!;
  const largeBaselineWeight = resolveModelCostWeight(largeBaseline, largeBaseline).weight;

  let samples: EvalSample[];
  let seed = datasetRef.seed;
  if (useCustomPrompts) {
    samples = customPrompts.slice(0, sampleCount).map((p, i) => ({
      id: p.id?.trim() || `p${i + 1}`,
      input: p.input.trim(),
      gold: p.gold?.trim() ?? '',
    }));
  } else {
    try {
      const loaded = await loadDataset(datasetRef.id, { maxSamples: sampleCount });
      samples = loaded.samples.slice(0, sampleCount);
      seed = loaded.seed;
    } catch (e) {
      yield {
        type: 'error',
        message: e instanceof Error ? e.message : 'Failed to load dataset',
      };
      return;
    }
  }
  const runId = `run_${Date.now().toString(36)}`;
  const targetsMeta: Array<{ targetId: string; label: string; kind: 'model' | 'router' }> = [
    ...models.map((m) => ({ targetId: m.id, label: m.label, kind: 'model' as const })),
  ];
  if (req.includeRouter && routerSmall && routerLarge) {
    targetsMeta.push({
      targetId: ROUTER_TARGET_ID,
      label: `Router (${routerSmall.label} / ${routerLarge.label})`,
      kind: 'router',
    });
  }

  const totalCalls = targetsMeta.length * samples.length;
  yield {
    type: 'start',
    runId,
    datasetId: datasetRef.id,
    sampleCount: samples.length,
    targets: targetsMeta,
    totalCalls,
    scored,
  };

  const targetSummaries: EvalTargetSummary[] = [];
  const routingLog: RouteDecision[] = [];
  let done = 0;
  const promptMax = maxTokensForTask(datasetRef.task);
  const modelsById = new Map<string, ModelRef>([
    ...models.map((m) => [m.id, m] as const),
    ...(routerSmall ? ([[routerSmall.id, routerSmall]] as const) : []),
    ...(routerLarge ? ([[routerLarge.id, routerLarge]] as const) : []),
  ]);

  const runTarget = async function* (
    targetId: string,
    label: string,
    kind: 'model' | 'router',
    pickModel: (sampleIndex: number) => { model: ModelRef; route?: RouteDecision },
    caveatModel?: ModelRef | null,
  ): AsyncGenerator<EvalStreamEvent, EvalTargetSummary, unknown> {
    const sampleResults: Array<EvalSampleResult & { timeToFirstTokenMs?: number }> = [];
    const costWeights: number[] = [];

    for (let i = 0; i < samples.length; i += 1) {
      assertNotAborted(signal);
      const sample = samples[i]!;
      const { model, route } = pickModel(i);
      if (route) routingLog.push(route);

      const prompt = buildEvalPrompt(datasetRef.task, sample.input);
      const result = await evalOneSample({
        model,
        prompt,
        gold: sample.gold,
        metric: datasetRef.metric,
        maxTokens: promptMax,
        sampleId: sample.id,
        route,
        scored,
      });
      sampleResults.push(result);
      costWeights.push(resolveModelCostWeight(model, largeBaseline).weight);
      done += 1;

      yield {
        type: 'progress',
        done,
        total: totalCalls,
        targetId,
        sampleIndex: i,
        sampleId: sample.id,
        score: result.error || !scored ? undefined : result.score,
        latencyMs: result.latencyMs,
        error: result.error,
        route,
      };
    }

    const summary = summarizeTarget({
      targetId,
      label,
      kind,
      metric: datasetRef.metric,
      sampleResults,
      costWeights,
      largeBaselineWeight,
    });

    const modelForCaveat = caveatModel ?? modelsById.get(targetId) ?? null;
    const costSource = modelForCaveat
      ? resolveModelCostWeight(modelForCaveat, largeBaseline).costSource
      : undefined;
    const extra: string[] = [];
    if (costSource === 'unmeasured-fallback') {
      extra.push('relative cost uses unmeasured fallback — run Benchmark on /deploy');
    }
    if (kind === 'router' && routerSmall && routerLarge) {
      extra.push(`router; small=${routerSmall.id}; large=${routerLarge.id}`);
    }

    const reported = withMandatoryCaveat(summary, {
      model: modelForCaveat,
      sampleCount: sampleResults.length,
      extraCaveat: extra.join('; ') || undefined,
      meanTtftMs: meanTtftMs(sampleResults),
      tokensPerSec: modelForCaveat?.selfHosted?.measuredTokPerSec ?? null,
      costSource,
    });

    yield { type: 'target_done', target: reported };
    return reported;
  };

  try {
    for (const model of models) {
      assertNotAborted(signal);
      const gen = runTarget(model.id, model.label, 'model', () => ({ model }), model);
      let step = await gen.next();
      while (!step.done) {
        yield step.value;
        step = await gen.next();
      }
      targetSummaries.push(step.value);
    }

    if (req.includeRouter && routerSmall && routerLarge) {
      assertNotAborted(signal);
      const pair = { small: routerSmall, large: routerLarge };
      const label = `Router (${routerSmall.label} / ${routerLarge.label})`;
      const gen = runTarget(
        ROUTER_TARGET_ID,
        label,
        'router',
        (i) => {
          const sample = samples[i]!;
          const route = routeSample(sample.id, sample.input, datasetRef.task, pair);
          const model = route.chosenTier === 'large' ? pair.large : pair.small;
          return { model, route };
        },
        null,
      );
      let step = await gen.next();
      while (!step.done) {
        yield step.value;
        step = await gen.next();
      }
      targetSummaries.push(step.value);
    }

    const enriched = ensureResultCaveats(
      enrichSummaries(targetSummaries, {
        largeBaselineId: largeBaseline.id,
        smallModelId: routerSmall?.id ?? models.find((m) => m.tier === 'small')?.id ?? null,
      }),
      {
        modelsById,
        sampleCount: samples.length,
        datasetId: datasetRef.id,
      },
    );

    const result: EvalRunResult = {
      meta: {
        runId,
        datasetId: datasetRef.id,
        datasetLabel: datasetRef.label,
        task: datasetRef.task,
        metric: datasetRef.metric,
        sampleCount: samples.length,
        seed,
        largeBaselineId: largeBaseline.id,
        finishedAt: new Date().toISOString(),
        scored,
        prompts: samples.map((s) => ({ id: s.id, input: s.input })),
      },
      targets: enriched,
      routingLog,
    };

    yield { type: 'done', result };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      yield { type: 'cancelled', message: 'Stopped' };
      return;
    }
    throw error;
  }
}
