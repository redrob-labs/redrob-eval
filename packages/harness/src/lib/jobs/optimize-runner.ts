/**
 * Background GEPA / RandomSearch optimize jobs.
 */
import type { DatasetTask, MetricId } from '../../config/datasets';
import { getDatasetById } from '../../config/datasets';
import type { ProviderId } from '../../config/models';
import { resolveEvalModel } from '../catalog/resolve';
import { loadDataset } from '../datasets';
import type { LoadedDataset } from '../datasets/types';
import { evaluateCandidate } from '../optimizer/evaluate-candidate';
import {
  buildCustomGoalSpec,
  customGoalToLoadedDataset,
  defaultInstructionFromGoal,
  type CustomGoalInput,
} from '../optimizer/custom-goal';
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
  /** Catalog dataset id (omit when using customGoal) */
  datasetId?: string;
  sampleCount?: number;
  /** Custom goal mode: goal + rubric + input-only examples */
  customGoal?: CustomGoalInput;
  /** Judge model for llm_judge (defaults to reflectModelId) */
  judgeModelId?: string;
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
  const optimizedAgainst = req.optimizedAgainst ?? ['train', 'val'];
  assertSplitIsolation({
    optimizedAgainst,
    reported: 'test',
  });

  const seedModel = await resolveEvalModel(req.seedModelId);
  if (!seedModel) throw new Error(`Unknown seed model: ${req.seedModelId}`);

  const seedGene: ModelGene = {
    catalogId: seedModel.id,
    modelId: seedModel.modelId,
    providerId: seedModel.providerId,
    relativeCostWeight: seedModel.relativeCostWeight,
  };

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
    modelCatalog.push(seedGene);
  }

  const isCustom = Boolean(req.customGoal);
  let task: DatasetTask;
  let metric: MetricId;
  let datasetId: string;
  let loaded: LoadedDataset;
  let customGoalFixed: { goal: string; rubric: string } | undefined;
  let referenceAnchors: import('../optimizer/custom-goal').ReferenceAnchor[] | undefined;
  let rubricLintMessage: string | undefined;
  let samples: Example[];

  if (isCustom) {
    const spec = buildCustomGoalSpec(req.customGoal!);
    customGoalFixed = { goal: spec.goal, rubric: spec.rubric };
    referenceAnchors = spec.anchors;
    if (!spec.rubricLint.ok) {
      rubricLintMessage = spec.rubricLint.message;
    }
    const synth = customGoalToLoadedDataset(spec);
    datasetId = synth.datasetId;
    task = synth.task;
    metric = synth.metric;
    samples = spec.examples;
    loaded = {
      ...synth,
      samples: spec.examples.map((e) => ({
        id: e.id,
        input: e.input,
        gold: e.gold ?? '',
      })),
    };
  } else {
    if (!req.datasetId) throw new Error('Provide datasetId or customGoal');
    const datasetRef = getDatasetById(req.datasetId);
    if (!datasetRef) throw new Error(`Unknown dataset id: ${req.datasetId}`);
    datasetId = datasetRef.id;
    task = datasetRef.task;
    metric = datasetRef.metric as MetricId;
    const sampleCount = Math.min(
      Math.max(5, Math.floor(req.sampleCount || 20)),
      datasetRef.maxSamples,
    );
    loaded = await loadDataset(req.datasetId, { maxSamples: sampleCount });
    samples = loaded.samples;
  }

  const split = splitExamples(samples, { train: 0.6, val: 0.2, test: 0.2 }, req.seed ?? 42);

  // Catalog demos use gold; custom goals are input-only — start with empty demos.
  const demoPool: Demo[] = isCustom
    ? []
    : split.train.slice(0, 8).map((s) => ({
        input: s.input,
        output: s.gold,
      }));

  const defaultInstruction =
    req.instruction?.trim() ||
    (isCustom && customGoalFixed
      ? defaultInstructionFromGoal(
          customGoalFixed.goal,
          task === 'checklist' ? 'checklist' : 'text',
        )
      : defaultInstructionForTask(task));

  const seed = seedCandidate({
    instruction: defaultInstruction,
    demos: isCustom ? [] : demoPool.slice(0, 2),
    // The model the run was started on, not the first entry of the pool it may mutate
    // within. Those are different whenever the page's model picker holds a selection,
    // and the run then optimises a model nobody chose while the manifest — which records
    // `seedModelId` — says otherwise. Caught with a live key: Seed was Llama 3.1 8B and
    // every rollout went to openai/gpt-4o, at fifty times the price.
    model: seedGene,
    scriptPolicies: defaultScriptBundle('passthrough'),
    framePolicy:
      task === 'checklist'
        ? { strategy: 'uniform', n_frames: 8, tokens_per_frame: 640 }
        : undefined,
    maxPromptTokens: req.maxPromptTokens ?? 2048,
    demosRequested: isCustom ? 0 : 2,
    framesRequested: task === 'checklist' ? 8 : undefined,
  });

  await ensureOptimizeDirs();
  const runId = makeOptimizeRunId(datasetId);
  const startedAt = new Date().toISOString();
  const qualityFloor =
    req.qualityFloor ?? (metric === 'qwk' || task === 'checklist' ? 0.6 : 0.5);
  const maxRollouts = req.maxRollouts ?? 12;
  const optimizerName = req.optimizer ?? 'gepa';

  const reflectResolved = req.reflectModelId
    ? await resolveEvalModel(req.reflectModelId)
    : seedModel;
  const judgeResolved = req.judgeModelId
    ? await resolveEvalModel(req.judgeModelId)
    : reflectResolved ?? seedModel;
  if (!judgeResolved && isCustom && metric === 'llm_judge') {
    throw new Error('Judge model required for custom goals');
  }

  const meta: OptimizeRunMeta = {
    runId,
    createdAt: startedAt,
    status: 'queued',
    datasetId,
    optimizer: optimizerName,
    qualityFloor,
    maxRollouts,
    seed: req.seed ?? 42,
    optimizedAgainst,
    mode: isCustom ? (task === 'checklist' ? 'checklist' : 'custom') : 'catalog',
    customGoal: customGoalFixed
      ? {
          goal: customGoalFixed.goal,
          rubric: customGoalFixed.rubric,
          exampleCount: samples.length,
          exampleIds: samples.map((s) => s.id),
          rubricLint: rubricLintMessage,
        }
      : undefined,
    judgeModelId: isCustom ? judgeResolved!.id : undefined,
  };
  await writeOptimizeMeta(runId, meta);
  await writeOptimizeManifest(
    runId,
    {
      ...buildRunManifest({
        seed: req.seed ?? 42,
        temperature: 0,
        small: seedModel,
        large: null,
        dataset: loaded,
        startedAtUtc: startedAt,
        finishedAtUtc: null,
        maxRollouts,
      }),
      customGoal: customGoalFixed
        ? {
            goal: customGoalFixed.goal,
            rubric: customGoalFixed.rubric,
            examples: samples.map((s) => ({ id: s.id, input: s.input })),
          }
        : undefined,
    },
  );

  const abort = new AbortController();
  const promise = (async () => {
    await patchOptimizeStatus(runId, 'running');
    try {
      const evaluate = async (candidate: Candidate, examples: Example[]) =>
        evaluateCandidate({
          candidate,
          examples,
          task,
          metric,
          signal: abort.signal,
          customGoal: customGoalFixed,
          referenceAnchors,
          judge:
            isCustom && metric === 'llm_judge'
              ? {
                  providerId: judgeResolved!.providerId as ProviderId,
                  modelId: judgeResolved!.modelId,
                }
              : undefined,
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
        customGoal: customGoalFixed,
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
            datasetId,
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
        {
          ...buildRunManifest({
            seed: req.seed ?? 42,
            temperature: 0,
            small: seedModel,
            large: null,
            dataset: loaded,
            startedAtUtc: startedAt,
            finishedAtUtc: new Date().toISOString(),
            maxRollouts,
          }),
          customGoal: customGoalFixed
            ? {
                goal: customGoalFixed.goal,
                rubric: customGoalFixed.rubric,
                examples: samples.map((s) => ({ id: s.id, input: s.input })),
              }
            : undefined,
        },
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
    case 'custom':
      return 'Follow the task instructions precisely.';
    case 'checklist':
      return (
        'Score the skill from sampled frames using observable binary checklist items only. ' +
        'Return JSON {"items":[0|1,...]} or ABSTAIN. No holistic ratings or causal explanations.'
      );
    default: {
      const _e: never = task;
      return _e;
    }
  }
}
