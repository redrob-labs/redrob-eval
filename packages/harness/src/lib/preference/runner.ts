/**
 * Background preference generation jobs (Stage 1).
 */
import { resolveEvalModel } from '../catalog/resolve';
import { callModel } from '../providers';
import { buildCustomGoalSpec, type CustomGoalInput } from '../optimizer/custom-goal';
import { buildRunManifest } from '../jobs/manifest-helpers';
import {
  assertIdenticalGenerationParams,
  taskIdFromSpecParts,
} from './params';
import { preferencePromptFingerprint } from './prompt';
import {
  callerResultFromProvider,
  runPreferenceGeneration,
  type PreferenceCaller,
} from './generate';
import {
  appendPreferenceEvent,
  appendPreferenceGeneration,
  ensurePreferenceDirs,
  makePreferenceRunId,
  patchPreferenceStatus,
  writePreferenceManifest,
  writePreferenceMeta,
  writePreferenceSummary,
} from './fs';
import type { PreferenceGenerationParams, PreferenceRun } from './types';

export type PreferenceJobRequest = {
  customGoal: CustomGoalInput;
  modelIds: string[];
  /** Subset of example ids; default = all */
  inputIds?: string[];
  generationParams?: Partial<PreferenceGenerationParams>;
  baselineModelId?: string;
};

type JobRecord = {
  runId: string;
  abort: AbortController;
  promise: Promise<void>;
};

const jobs = new Map<string, JobRecord>();

export function getActivePreferenceJob(runId: string): JobRecord | undefined {
  return jobs.get(runId);
}

export function abortPreferenceJob(runId: string): boolean {
  const job = jobs.get(runId);
  if (!job) return false;
  job.abort.abort();
  return true;
}

function liveCaller(): PreferenceCaller {
  return async ({ modelId, system, user, params }) => {
    const resolved = await resolveEvalModel(modelId);
    if (!resolved) {
      throw new Error(`Unknown model id: ${modelId}`);
    }
    const result = await callModel(resolved.providerId, resolved.modelId, user, {
      systemPrompt: system,
      maxTokens: params.maxTokens, // null = unlimited
      temperature: params.temperature,
    });
    return callerResultFromProvider({
      text: result.text,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cachedInputTokens: result.cachedInputTokens,
      reasoningTokens: result.reasoningTokens,
      finishReason: result.finishReason,
      latencyMs: result.latencyMs,
      timeToFirstTokenMs: result.timeToFirstTokenMs,
    });
  };
}

export async function startPreferenceJob(
  req: PreferenceJobRequest,
): Promise<{ runId: string }> {
  if (!req.modelIds?.length) throw new Error('modelIds required');
  const task = buildCustomGoalSpec(req.customGoal);
  const generationParams = assertIdenticalGenerationParams(req.generationParams ?? {});
  const taskId = taskIdFromSpecParts({
    goal: task.goal,
    rubric: task.rubric,
    exampleIds: task.examples.map((e) => e.id),
  });
  const inputIds =
    req.inputIds?.length ? req.inputIds : task.examples.map((e) => e.id);
  for (const id of inputIds) {
    if (!task.examples.some((e) => e.id === id)) {
      throw new Error(`Unknown inputId: ${id}`);
    }
  }

  await ensurePreferenceDirs();
  const runId = makePreferenceRunId(taskId);
  const run: PreferenceRun = {
    id: runId,
    taskId,
    task,
    modelIds: [...req.modelIds],
    inputIds: [...inputIds],
    generationParams,
    promptFingerprint: preferencePromptFingerprint(task),
    createdAt: new Date().toISOString(),
    status: 'queued',
    baselineModelId: req.baselineModelId,
  };
  await writePreferenceMeta(run);
  await writePreferenceManifest(
    runId,
    {
      ...buildRunManifest({
        seed: generationParams.seed ?? null,
        temperature: generationParams.temperature,
        small: null,
        large: null,
        dataset: null,
        startedAtUtc: run.createdAt,
        maxRollouts: null,
      }),
      datasetId: taskId,
      customGoal: {
        goal: task.goal,
        rubric: task.rubric,
        examples: task.examples.map((e) => ({ id: e.id, input: e.input })),
      },
    },
  );

  const abort = new AbortController();
  const promise = (async () => {
    try {
      await patchPreferenceStatus(runId, 'running');
      const examplesById = new Map(task.examples.map((e) => [e.id, e]));
      const weights: Record<string, number> = {};
      for (const id of req.modelIds) {
        const m = await resolveEvalModel(id);
        if (m) weights[id] = m.relativeCostWeight;
      }
      await appendPreferenceEvent(runId, {
        type: 'start',
        runId,
        total: req.modelIds.length * inputIds.length,
      });

      const { summary } = await runPreferenceGeneration({
        run: { ...run, status: 'running' },
        examplesById,
        caller: liveCaller(),
        relativeCostWeightByModel: weights,
        onCell: async (g, matrix) => {
          if (abort.signal.aborted) throw new Error('aborted');
          await appendPreferenceGeneration(runId, g);
          await appendPreferenceEvent(runId, {
            type: 'cell',
            runId,
            modelId: g.modelId,
            inputId: g.inputId,
            status: matrix.cells[g.modelId]?.[g.inputId] ?? 'error',
            done: matrix.completed,
            total: matrix.total,
          });
        },
      });

      if (abort.signal.aborted) {
        await patchPreferenceStatus(runId, 'stopped');
        await appendPreferenceEvent(runId, {
          type: 'cancelled',
          runId,
          message: 'Stopped',
        });
        return;
      }

      await writePreferenceSummary(runId, summary);
      await patchPreferenceStatus(runId, 'ready');
      await appendPreferenceEvent(runId, { type: 'done', runId, summary });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Preference generation failed';
      if (abort.signal.aborted || message === 'aborted') {
        await patchPreferenceStatus(runId, 'stopped');
        await appendPreferenceEvent(runId, {
          type: 'cancelled',
          runId,
          message: 'Stopped',
        });
      } else {
        await patchPreferenceStatus(runId, 'failed', { error: message });
        await appendPreferenceEvent(runId, { type: 'error', runId, message });
      }
    } finally {
      jobs.delete(runId);
    }
  })();

  jobs.set(runId, { runId, abort, promise });
  return { runId };
}
