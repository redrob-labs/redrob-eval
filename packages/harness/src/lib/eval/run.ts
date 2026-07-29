import { getDatasetById, type MetricId } from '../../config/datasets';
import type { ModelRef } from '../../config/models';
import { resolveEvalModel, resolveEvalModels } from '../catalog/resolve';
import { loadDataset } from '../datasets/index';
import { scorePair } from '../metrics/index';
import { callModel, ProviderError } from '../providers/index';
import { routeSample, type RouteDecision } from '../router/index';
import { enrichSummaries, pickLargeBaseline, summarizeTarget } from './aggregate';
import { buildEvalPrompt, maxTokensForTask } from './prompts';
import {
  ROUTER_TARGET_ID,
  type EvalRunResult,
  type EvalSampleResult,
  type EvalStreamEvent,
  type EvalTargetSummary,
} from './types';

export interface EvalRunRequest {
  datasetId: string;
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

async function evalOneSample(params: {
  model: ModelRef;
  prompt: string;
  gold: string;
  metric: MetricId;
  maxTokens: number;
  sampleId: string;
  route?: RouteDecision;
}): Promise<EvalSampleResult> {
  try {
    const result = await callModel(params.model.providerId, params.model.modelId, params.prompt, {
      maxTokens: params.maxTokens,
      temperature: 0,
    });
    const scored = scorePair(params.metric, params.gold, result.text);
    return {
      sampleId: params.sampleId,
      score: scored.score,
      latencyMs: result.latencyMs,
      prediction: result.text,
      route: params.route,
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

/**
 * Run a full eval, yielding SSE-friendly events.
 */
export async function* runEval(
  req: EvalRunRequest,
  opts?: { signal?: AbortSignal },
): AsyncGenerator<EvalStreamEvent, void, unknown> {
  const signal = opts?.signal;
  const datasetRef = getDatasetById(req.datasetId);
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
  const largeBaselineWeight = largeBaseline.relativeCostWeight;

  let loaded;
  try {
    loaded = await loadDataset(req.datasetId, { maxSamples: sampleCount });
  } catch (e) {
    yield {
      type: 'error',
      message: e instanceof Error ? e.message : 'Failed to load dataset',
    };
    return;
  }

  const samples = loaded.samples.slice(0, sampleCount);
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
    datasetId: req.datasetId,
    sampleCount: samples.length,
    targets: targetsMeta,
    totalCalls,
  };

  const targetSummaries: EvalTargetSummary[] = [];
  const routingLog: RouteDecision[] = [];
  let done = 0;
  const promptMax = maxTokensForTask(datasetRef.task);

  const runTarget = async function* (
    targetId: string,
    label: string,
    kind: 'model' | 'router',
    pickModel: (sampleIndex: number) => { model: ModelRef; route?: RouteDecision },
  ): AsyncGenerator<EvalStreamEvent, EvalTargetSummary, unknown> {
    const sampleResults: EvalSampleResult[] = [];
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
      });
      sampleResults.push(result);
      costWeights.push(model.relativeCostWeight);
      done += 1;

      yield {
        type: 'progress',
        done,
        total: totalCalls,
        targetId,
        sampleIndex: i,
        sampleId: sample.id,
        score: result.error ? undefined : result.score,
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
    yield { type: 'target_done', target: summary };
    return summary;
  };

  try {
    for (const model of models) {
      assertNotAborted(signal);
      const gen = runTarget(model.id, model.label, 'model', () => ({ model }));
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
      const gen = runTarget(ROUTER_TARGET_ID, label, 'router', (i) => {
        const sample = samples[i]!;
        const route = routeSample(sample.id, sample.input, datasetRef.task, pair);
        const model = route.chosenTier === 'large' ? pair.large : pair.small;
        return { model, route };
      });
      let step = await gen.next();
      while (!step.done) {
        yield step.value;
        step = await gen.next();
      }
      targetSummaries.push(step.value);
    }

    const enriched = enrichSummaries(targetSummaries, {
      largeBaselineId: largeBaseline.id,
      smallModelId: routerSmall?.id ?? models.find((m) => m.tier === 'small')?.id ?? null,
    });

    const result: EvalRunResult = {
      meta: {
        runId,
        datasetId: datasetRef.id,
        datasetLabel: datasetRef.label,
        task: datasetRef.task,
        metric: datasetRef.metric,
        sampleCount: samples.length,
        seed: loaded.seed,
        largeBaselineId: largeBaseline.id,
        finishedAt: new Date().toISOString(),
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
