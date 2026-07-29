/**
 * Background GEPA / RandomSearch optimize jobs.
 */
import type { DatasetTask, MetricId } from '../../config/datasets';
import { getDatasetById } from '../../config/datasets';
import { resolveEvalModel } from '../catalog/resolve';
import { loadDataset } from '../datasets';
import { evaluateCandidate } from '../optimizer/evaluate-candidate';
import { Gepa } from '../optimizer/gepa/engine';
import { RandomSearch } from '../optimizer/random-search';
import type {
  Candidate,
  Demo,
  Example,
  ModelGene,
  OptimizeEvent,
} from '../optimizer/types';
import { seedCandidate } from '../optimizer/types';
import { assertSplitIsolation, splitExamples } from '../splits';
import { buildRunManifest } from './manifest-helpers';
import {
  appendOptimizeEvent,
  ensureOptimizeDirs,
  makeOptimizeRunId,
  patchOptimizeStatus,
  writeOptimizeFrontier,
  writeOptimizeManifest,
  writeOptimizeMeta,
  writeOptimizeResult,
  writeOptimizeReport,
  type OptimizeRunMeta,
} from './optimize-fs';
import { buildOptimizeReport, reportToMarkdown } from '../optimizer/report';
import { defaultScriptBundle } from '../script-policy';

export interface OptimizeJobRequest {
  datasetId: string;
  sampleCount: number;
  /** Default instruction to evolve */
  instruction?: string;
  seedModelId: string;
  reflectModelId?: string;
  modelCatalogIds?: string[];
  qualityFloor?: number;
  maxRollouts?: number;
  minibatchSize?: number;
  mergeEvery?: number;
  seed?: number;
  optimizer?: 'gepa' | 'random';
  /** Context budget for demo fitting (null = unlimited) */
  maxPromptTokens?: number | null;
  /** Must not include test if we report test at the end */
  optimizedAgainst?: Array<'train' | 'val' | 'test'>;
}

type JobRecord = {
  runId: string;
  abort: AbortController;
  promise: Promise<void>;
};

const jobs = new Map<string, JobRecord>();

export function getActiveOptimizeJob(runId: string): JobRecord | undefined {
  return jobs.get(runId);
}

export function abortOptimizeJob(runId: string): boolean {
  const job = jobs.get(runId);
  if (!job) return false;
  job.abort.abort();
  return true;
}

export async function startOptimizeJob(
  req: OptimizeJobRequest,
): Promise<{ runId: string }> {
  const datasetRef = getDatasetById(req.datasetId);
  if (!datasetRef) throw new Error(`Unknown dataset id: ${req.datasetId}`);

  const optimizedAgainst = req.optimizedAgainst ?? ['train', 'val'];
  // Refuse to start a run that would optimize against test AND report test
  assertSplitIsolation({
    optimizedAgainst,
    reported: 'test',
  });

  const seedModel = await resolveEvalModel(req.seedModelId);
  if (!seedModel) throw new Error(`Unknown seed model: ${req.seedModelId}`);

  const catalogIds = req.modelCatalogIds?.length
    ? req.modelCatalogIds
    : [req.seedModelId];
  const modelCatalog: ModelGene[] = [];
  for (const id of catalogIds) {
    const m = await resolveEvalModel(id);
    if (m) {
      modelCatalog.push({
        catalogId: m.id,
        modelId: m.modelId,
        providerId: m.providerId,
        relativeCostWeight: m.relativeCostWeight,
      });
    }
  }
  if (modelCatalog.length === 0) {
    modelCatalog.push({
      catalogId: seedModel.id,
      modelId: seedModel.modelId,
      providerId: seedModel.providerId,
      relativeCostWeight: seedModel.relativeCostWeight,
    });
  }

  const sampleCount = Math.min(
    Math.max(5, Math.floor(req.sampleCount || 20)),
    datasetRef.maxSamples,
  );
  const loaded = await loadDataset(req.datasetId, { maxSamples: sampleCount });
  const split = splitExamples(loaded.samples, { train: 0.6, val: 0.2, test: 0.2 }, req.seed ?? 42);

  // Demo pool from train gold pairs
  const demoPool: Demo[] = split.train.slice(0, 8).map((s) => ({
    input: s.input,
    output: s.gold,
  }));

  const defaultInstruction =
    req.instruction?.trim() ||
    defaultInstructionForTask(datasetRef.task);

  const seed = seedCandidate({
    instruction: defaultInstruction,
    demos: demoPool.slice(0, 2),
    model: modelCatalog[0]!,
    scriptPolicies: defaultScriptBundle('passthrough'),
    maxPromptTokens: req.maxPromptTokens ?? 2048,
    demosRequested: 2,
  });

  await ensureOptimizeDirs();
  const runId = makeOptimizeRunId(datasetRef.id);
  const startedAt = new Date().toISOString();
  const qualityFloor = req.qualityFloor ?? 0.5;
  const maxRollouts = req.maxRollouts ?? 12;
  const optimizerName = req.optimizer ?? 'gepa';

  const meta: OptimizeRunMeta = {
    runId,
    createdAt: startedAt,
    status: 'queued',
    datasetId: datasetRef.id,
    optimizer: optimizerName,
    qualityFloor,
    maxRollouts,
    seed: req.seed ?? 42,
    optimizedAgainst,
  };
  await writeOptimizeMeta(runId, meta);
  await writeOptimizeManifest(
    runId,
    buildRunManifest({
      seed: req.seed ?? 42,
      temperature: 0,
      small: seedModel,
      large: null,
      dataset: loaded,
      startedAtUtc: startedAt,
      finishedAtUtc: null,
      maxRollouts,
    }),
  );

  const reflectResolved = req.reflectModelId
    ? await resolveEvalModel(req.reflectModelId)
    : seedModel;

  const abort = new AbortController();
  const promise = (async () => {
    await patchOptimizeStatus(runId, 'running');
    try {
      const evaluate = async (candidate: Candidate, examples: Example[]) =>
        evaluateCandidate({
          candidate,
          examples,
          task: datasetRef.task,
          metric: datasetRef.metric as MetricId,
          signal: abort.signal,
        });

      const optimizer =
        optimizerName === 'random'
          ? new RandomSearch()
          : new Gepa();

      let lastFrontier: OptimizeEvent | null = null;
      let doneEvent: Extract<OptimizeEvent, { type: 'done' }> | null = null;

      for await (const event of optimizer.optimize({
        seed: req.seed ?? 42,
        maxRollouts,
        qualityFloor,
        minibatchSize: req.minibatchSize ?? 4,
        mergeEvery: req.mergeEvery ?? 3,
        reflectModelId: (reflectResolved ?? seedModel).modelId,
        reflectProviderId: (reflectResolved ?? seedModel).providerId,
        candidates: [seed],
        demoPool,
        modelCatalog,
        split: {
          train: split.train,
          val: split.val,
          test: split.test,
        },
        optimizedAgainst,
        evaluate,
        signal: abort.signal,
      })) {
        const stamped =
          event.type === 'start' ? { ...event, runId } : event;
        await appendOptimizeEvent(runId, stamped);
        if (event.type === 'frontier') {
          lastFrontier = event;
          await writeOptimizeFrontier(runId, event.points);
        }
        if (event.type === 'done') {
          doneEvent = event;
          await writeOptimizeResult(runId, event);
          await writeOptimizeFrontier(runId, event.frontier);
          const report = buildOptimizeReport({
            runId,
            qualityFloor,
            datasetId: datasetRef.id,
            optimizer: optimizerName,
            baseline: event.baseline ?? seed,
            baselineVal: event.baselineVal,
            evolved: event.best,
            evolvedVal: event.bestVal,
            evolvedTest: event.test,
            frontier: event.frontier,
          });
          await writeOptimizeReport(runId, report, reportToMarkdown(report));
        }
        if (event.type === 'error') {
          await patchOptimizeStatus(runId, 'failed', { error: event.message });
          return;
        }
        if (event.type === 'cancelled') {
          await patchOptimizeStatus(runId, 'stopped');
          return;
        }
      }

      await writeOptimizeManifest(
        runId,
        buildRunManifest({
          seed: req.seed ?? 42,
          temperature: 0,
          small: seedModel,
          large: null,
          dataset: loaded,
          startedAtUtc: startedAt,
          finishedAtUtc: new Date().toISOString(),
          maxRollouts,
        }),
      );
      await patchOptimizeStatus(runId, 'ready');
      if (!doneEvent && lastFrontier) {
        await writeOptimizeResult(runId, { type: 'done', note: 'incomplete', lastFrontier });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Optimize failed';
      const cancelled = err instanceof Error && err.name === 'AbortError';
      await appendOptimizeEvent(runId, {
        type: cancelled ? 'cancelled' : 'error',
        message: cancelled ? 'Stopped' : message,
      });
      await patchOptimizeStatus(runId, cancelled ? 'stopped' : 'failed', {
        error: cancelled ? undefined : message,
      });
    } finally {
      jobs.delete(runId);
    }
  })();

  jobs.set(runId, { runId, abort, promise });
  return { runId };
}

function defaultInstructionForTask(task: DatasetTask): string {
  switch (task) {
    case 'translation':
      return 'You are a careful Hindi→English translator. Preserve named entities and meaning. Output only the English translation.';
    case 'classification':
      return 'You are a Hindi sentiment classifier. Reply with only 0 (negative), 1 (neutral), or 2 (positive).';
    case 'math':
      return 'You solve grade-school math carefully. Show brief steps and end with #### <number>.';
    default:
      return 'Follow the task instructions precisely.';
  }
}
