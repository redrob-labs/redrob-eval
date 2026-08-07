import { getDatasetById, type MetricId } from '../../config/datasets';
import type { ModelRef } from '../../config/models';
import { resolveModelCostWeight } from '../../config/models';
import { resolveEvalModel } from '../catalog/resolve';
import { loadDataset } from '../datasets/index';
import type { EvalRunResult, EvalStreamEvent } from '../eval/types';
import { enrichSummaries } from '../eval/aggregate';
import { buildEvalPrompt, maxTokensForTask } from '../eval/prompts';
import { ensureResultCaveats, withMandatoryCaveat } from '../eval/results';
import { scorePair } from '../metrics/index';
import { callModel, ProviderError } from '../providers/index';
import { routeSample } from '../router/index';
import { extractRoutingFeatures } from './features';
import {
  appendRoutingExample,
  computeAndWriteCorpusStats,
  ensureRoutingDirs,
  makeRoutingRunId,
  writeRoutingMeta,
  writeRoutingSummary,
} from './fs';
import { defaultSmallOkThreshold, labelRoute } from './labels';
import { modelAloneSummary, replayPolicy } from './replay';
import type {
  ModelCallRecord,
  RoutingExample,
  RoutingRunMeta,
  RoutingRunSummary,
} from './types';

export interface RoutingCollectRequest {
  datasetId: string;
  sampleCount: number;
  smallModelId: string;
  largeModelId: string;
  /** Score threshold: small is good enough if score ≥ this (default by metric) */
  smallOkThreshold?: number;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('Stopped');
    err.name = 'AbortError';
    throw err;
  }
}

async function callAndScore(params: {
  model: ModelRef;
  prompt: string;
  gold: string;
  metric: MetricId;
  maxTokens: number;
  largeBaseline: ModelRef;
}): Promise<ModelCallRecord> {
  const { weight } = resolveModelCostWeight(params.model, params.largeBaseline);
  try {
    const result = await callModel(params.model.providerId, params.model.modelId, params.prompt, {
      maxTokens: params.maxTokens,
      temperature: 0,
    });
    const scored = scorePair(params.metric, params.gold, result.text);
    return {
      modelId: params.model.id,
      modelLabel: params.model.label,
      relativeCostWeight: weight,
      prediction: result.text,
      score: scored.score,
      feedback: scored.feedback,
      latencyMs: result.latencyMs,
      timeToFirstTokenMs: result.timeToFirstTokenMs,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  } catch (error) {
    const message =
      error instanceof ProviderError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Model call failed';
    return {
      modelId: params.model.id,
      modelLabel: params.model.label,
      relativeCostWeight: weight,
      prediction: '',
      score: 0,
      latencyMs: 0,
      error: message,
    };
  }
}

function buildSummary(
  meta: RoutingRunMeta,
  examples: RoutingExample[],
  largeBaselineWeight: number,
): RoutingRunSummary {
  const smallAlone = modelAloneSummary({
    examples,
    tier: 'small',
    metric: meta.metric,
    largeBaselineWeight,
  });
  const largeAlone = modelAloneSummary({
    examples,
    tier: 'large',
    metric: meta.metric,
    largeBaselineWeight,
  });
  const oracle = replayPolicy({
    examples,
    policy: 'oracle',
    metric: meta.metric,
    largeBaselineWeight,
  });
  const heuristic = replayPolicy({
    examples,
    policy: 'heuristic',
    metric: meta.metric,
    largeBaselineWeight,
  });

  return {
    meta,
    saveRate: meta.labeled ? meta.labelSmall / meta.labeled : 0,
    oracleQuality: oracle.quality,
    oracleRelativeCostPct: oracle.relativeCostPct,
    heuristicAgreeWithOracle: heuristic.routingOracleAccuracy ?? 0,
    smallAloneQuality: smallAlone.quality,
    largeAloneQuality: largeAlone.quality,
  };
}

/**
 * Dual-eval collection for routing-SLM training.
 * Always calls small + large per sample, labels outcome-supervised targets,
 * persists examples to eval/routing-runs + corpus, and replays policies for Pareto.
 */
export async function* runRoutingCollection(
  req: RoutingCollectRequest,
  opts?: { signal?: AbortSignal; runId?: string },
): AsyncGenerator<EvalStreamEvent> {
  const signal = opts?.signal;
  const datasetRef = getDatasetById(req.datasetId);
  if (!datasetRef) {
    yield { type: 'error', message: `Unknown dataset id: ${req.datasetId}` };
    return;
  }

  const small = await resolveEvalModel(req.smallModelId);
  const large = await resolveEvalModel(req.largeModelId);
  if (!small || !large) {
    yield { type: 'error', message: 'Provide valid smallModelId and largeModelId' };
    return;
  }
  if (small.id === large.id) {
    yield { type: 'error', message: 'Small and large models must differ' };
    return;
  }

  const sampleCount = Math.min(
    Math.max(1, Math.floor(req.sampleCount)),
    datasetRef.maxSamples,
  );
  const threshold =
    req.smallOkThreshold ?? defaultSmallOkThreshold(datasetRef.metric);

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
  await ensureRoutingDirs();
  const runId = opts?.runId ?? makeRoutingRunId(datasetRef.id);
  const createdAt = new Date().toISOString();

  const meta: RoutingRunMeta = {
    runId,
    createdAt,
    status: 'running',
    datasetId: datasetRef.id,
    datasetLabel: datasetRef.label,
    task: datasetRef.task,
    metric: datasetRef.metric,
    sampleCount: samples.length,
    seed: loaded.seed,
    smallModelId: small.id,
    largeModelId: large.id,
    smallModelLabel: small.label,
    largeModelLabel: large.label,
    smallOkThreshold: threshold,
    labeled: 0,
    labelSmall: 0,
    labelLarge: 0,
  };
  await writeRoutingMeta(runId, meta);

  const totalCalls = samples.length * 2;
  const targetsMeta = [
    { targetId: small.id, label: small.label, kind: 'model' as const },
    { targetId: large.id, label: large.label, kind: 'model' as const },
    { targetId: 'router-heuristic', label: 'Router · heuristic', kind: 'router' as const },
    { targetId: 'router-oracle', label: 'Router · oracle', kind: 'router' as const },
    { targetId: 'router-cascade', label: 'Router · cascade', kind: 'router' as const },
  ];

  yield {
    type: 'start',
    runId,
    datasetId: req.datasetId,
    sampleCount: samples.length,
    targets: targetsMeta,
    totalCalls,
  };

  const examples: RoutingExample[] = [];
  const promptMax = maxTokensForTask(datasetRef.task);
  const largeBaselineWeight = resolveModelCostWeight(large, large).weight;
  let done = 0;

  try {
    for (let i = 0; i < samples.length; i += 1) {
      assertNotAborted(signal);
      const sample = samples[i]!;
      const prompt = buildEvalPrompt(datasetRef.task, sample.input);

      const smallCall = await callAndScore({
        model: small,
        prompt,
        gold: sample.gold,
        metric: datasetRef.metric,
        maxTokens: promptMax,
        largeBaseline: large,
      });
      done += 1;
      yield {
        type: 'progress',
        done,
        total: totalCalls,
        targetId: small.id,
        sampleIndex: i,
        sampleId: sample.id,
        score: smallCall.error ? undefined : smallCall.score,
        latencyMs: smallCall.latencyMs,
        error: smallCall.error,
      };

      assertNotAborted(signal);
      const largeCall = await callAndScore({
        model: large,
        prompt,
        gold: sample.gold,
        metric: datasetRef.metric,
        maxTokens: promptMax,
        largeBaseline: large,
      });
      done += 1;
      yield {
        type: 'progress',
        done,
        total: totalCalls,
        targetId: large.id,
        sampleIndex: i,
        sampleId: sample.id,
        score: largeCall.error ? undefined : largeCall.score,
        latencyMs: largeCall.latencyMs,
        error: largeCall.error,
      };

      const features = extractRoutingFeatures({
        input: sample.input,
        task: datasetRef.task,
        datasetId: datasetRef.id,
      });
      const heuristic = routeSample(sample.id, sample.input, datasetRef.task, {
        small,
        large,
      });
      const { label, reason } = labelRoute({
        small: smallCall,
        large: largeCall,
        smallOkThreshold: threshold,
      });

      const example: RoutingExample = {
        id: `${runId}__${sample.id}`,
        runId,
        createdAt: new Date().toISOString(),
        sampleId: sample.id,
        datasetId: datasetRef.id,
        datasetLabel: datasetRef.label,
        task: datasetRef.task,
        metric: datasetRef.metric,
        seed: loaded.seed,
        input: sample.input,
        gold: sample.gold,
        small: smallCall,
        large: largeCall,
        label,
        labelReason: reason,
        smallOkThreshold: threshold,
        features,
        heuristic,
      };

      examples.push(example);
      await appendRoutingExample(runId, example);

      meta.labeled = examples.length;
      meta.labelSmall = examples.filter((e) => e.label === 'small').length;
      meta.labelLarge = examples.filter((e) => e.label === 'large').length;
      await writeRoutingMeta(runId, meta);
    }

    const smallSum = modelAloneSummary({
      examples,
      tier: 'small',
      metric: datasetRef.metric,
      largeBaselineWeight,
    });
    const largeSum = modelAloneSummary({
      examples,
      tier: 'large',
      metric: datasetRef.metric,
      largeBaselineWeight,
    });
    const heuristicSum = replayPolicy({
      examples,
      policy: 'heuristic',
      metric: datasetRef.metric,
      largeBaselineWeight,
    });
    const oracleSum = replayPolicy({
      examples,
      policy: 'oracle',
      metric: datasetRef.metric,
      largeBaselineWeight,
    });
    const cascadeSum = replayPolicy({
      examples,
      policy: 'cascade',
      metric: datasetRef.metric,
      largeBaselineWeight,
    });

    const meanTtft = (tier: 'small' | 'large') => {
      const vals = examples
        .map((e) => (tier === 'small' ? e.small : e.large).timeToFirstTokenMs)
        .filter((n): n is number => n != null && Number.isFinite(n));
      if (!vals.length) return null;
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    };
    const meanTokPerSec = (tier: 'small' | 'large') => {
      const rates: number[] = [];
      for (const e of examples) {
        const c = tier === 'small' ? e.small : e.large;
        if (c.error || !c.outputTokens || c.latencyMs <= 0) continue;
        rates.push((c.outputTokens / c.latencyMs) * 1000);
      }
      if (!rates.length) return null;
      return rates.reduce((a, b) => a + b, 0) / rates.length;
    };

    const smallReported = withMandatoryCaveat(smallSum, {
      model: small,
      sampleCount: samples.length,
      meanTtftMs: meanTtft('small'),
      tokensPerSec: small.selfHosted?.measuredTokPerSec ?? meanTokPerSec('small'),
      costSource: resolveModelCostWeight(small, large).costSource,
    });
    const largeReported = withMandatoryCaveat(largeSum, {
      model: large,
      sampleCount: samples.length,
      meanTtftMs: meanTtft('large'),
      tokensPerSec: large.selfHosted?.measuredTokPerSec ?? meanTokPerSec('large'),
      costSource: resolveModelCostWeight(large, large).costSource,
    });
    const routerCaveat = (label: string) =>
      withMandatoryCaveat(
        label === 'heuristic'
          ? heuristicSum
          : label === 'oracle'
            ? oracleSum
            : cascadeSum,
        {
          sampleCount: samples.length,
          extraCaveat: `router=${label}; small=${small.id}; large=${large.id}`,
        },
      );

    yield { type: 'target_done', target: smallReported };
    yield { type: 'target_done', target: largeReported };
    yield { type: 'target_done', target: routerCaveat('heuristic') };
    yield { type: 'target_done', target: routerCaveat('oracle') };
    yield { type: 'target_done', target: routerCaveat('cascade') };

    const targets = ensureResultCaveats(
      enrichSummaries(
        [
          smallReported,
          largeReported,
          routerCaveat('heuristic'),
          routerCaveat('oracle'),
          routerCaveat('cascade'),
        ],
        { largeBaselineId: large.id, smallModelId: small.id },
      ),
      {
        modelsById: new Map([
          [small.id, small],
          [large.id, large],
        ]),
        sampleCount: samples.length,
        datasetId: datasetRef.id,
      },
    );

    meta.status = 'ready';
    meta.finishedAt = new Date().toISOString();
    await writeRoutingMeta(runId, meta);

    const summary = buildSummary(meta, examples, largeBaselineWeight);
    await writeRoutingSummary(runId, summary);
    await computeAndWriteCorpusStats();

    const result: EvalRunResult = {
      meta: {
        runId,
        datasetId: datasetRef.id,
        datasetLabel: datasetRef.label,
        task: datasetRef.task,
        metric: datasetRef.metric,
        sampleCount: samples.length,
        seed: loaded.seed,
        largeBaselineId: large.id,
        finishedAt: meta.finishedAt,
      },
      targets,
      routingLog: examples.map((e) => e.heuristic),
    };

    yield { type: 'done', result };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      meta.status = 'stopped';
      meta.finishedAt = new Date().toISOString();
      meta.error = 'Stopped';
      await writeRoutingMeta(runId, meta);
      if (examples.length) {
        const summary = buildSummary(meta, examples, largeBaselineWeight);
        await writeRoutingSummary(runId, summary);
      }
      await computeAndWriteCorpusStats();
      yield { type: 'cancelled', message: 'Stopped' };
      return;
    }
    meta.status = 'failed';
    meta.error = error instanceof Error ? error.message : 'Collection failed';
    meta.finishedAt = new Date().toISOString();
    await writeRoutingMeta(runId, meta);
    throw error;
  }
}
