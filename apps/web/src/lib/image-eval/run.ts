import { resolveEvalModel } from '@redrob/harness';
import { generateOpenRouterImage } from './generate';
import {
  ensureRunsDir,
  makeRunId,
  saveRunImage,
  writeArtifacts,
  writeRatings,
  writeRunMeta,
} from './fs';
import { applyAutoJudgeToRating, judgePreference } from './judge';
import { emptyPreferenceRatings } from './ratings';
import { loadSuite } from './suite';
import type {
  ImageArtifact,
  ImageRunMeta,
  ImageRunStreamEvent,
} from './types';

export type ImageEvalRunRequest = {
  suiteId: string;
  modelIds: string[];
  seed?: number;
  promptLimit?: number;
  autoJudge?: boolean;
  judgeModelId?: string;
};

function toOpenRouterId(catalogId: string, modelId: string): string {
  if (catalogId.startsWith('or/')) return catalogId.slice(3);
  return modelId;
}

async function resolveJudgeOpenrouterId(judgeModelId?: string): Promise<string> {
  const id = judgeModelId?.trim() || 'or/openai/gpt-4o';
  const resolved = await resolveEvalModel(id);
  if (!resolved) throw new Error(`Unknown judge model: ${id}`);
  return toOpenRouterId(resolved.id, resolved.modelId);
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('Stopped');
    err.name = 'AbortError';
    throw err;
  }
}

export async function* runImagePreference(
  req: ImageEvalRunRequest,
  opts?: { signal?: AbortSignal },
): AsyncGenerator<ImageRunStreamEvent> {
  const signal = opts?.signal;
  const suite = await loadSuite(req.suiteId);
  if (!suite) {
    yield { type: 'error', message: `Unknown suite: ${req.suiteId}` };
    return;
  }

  if (!Array.isArray(req.modelIds) || req.modelIds.length < 1) {
    yield { type: 'error', message: 'Select at least one image model' };
    return;
  }

  const seed = Number.isFinite(req.seed) ? Number(req.seed) : 42;
  const limit =
    Number.isFinite(req.promptLimit) && (req.promptLimit as number) > 0
      ? Math.min(suite.prompts.length, Math.floor(req.promptLimit as number))
      : suite.prompts.length;
  const prompts = suite.prompts.slice(0, limit);

  const models = [];
  for (const id of req.modelIds) {
    const m = await resolveEvalModel(id);
    if (!m) {
      yield { type: 'error', message: `Unknown model: ${id}` };
      return;
    }
    models.push(m);
  }

  await ensureRunsDir();
  const runId = makeRunId(suite.suite);
  const modelLabels = Object.fromEntries(models.map((m) => [m.id, m.label]));
  const meta: ImageRunMeta = {
    runId,
    suiteId: suite.suite,
    createdAt: new Date().toISOString(),
    seed,
    modelIds: models.map((m) => m.id),
    modelLabels,
    promptIds: prompts.map((p) => p.id),
    status: 'running',
    autoJudge: Boolean(req.autoJudge),
    judgeModelId: req.autoJudge
      ? req.judgeModelId?.trim() || 'or/openai/gpt-4o'
      : undefined,
    scoring: 'preference',
  };
  await writeRunMeta(runId, meta);
  const limitedSuite = { ...suite, prompts };
  await writeRatings(runId, emptyPreferenceRatings(limitedSuite, meta.modelIds));

  const total = prompts.length * models.length;
  yield {
    type: 'start',
    runId,
    total,
    promptCount: prompts.length,
    models: models.map((m) => ({ id: m.id, label: m.label })),
  };

  const artifacts: ImageArtifact[] = [];
  let done = 0;

  try {
    for (const prompt of prompts) {
      for (const model of models) {
        assertNotAborted(signal);
        try {
          const openrouterId = toOpenRouterId(model.id, model.modelId);
          const img = await generateOpenRouterImage({
            openrouterModelId: openrouterId,
            prompt: prompt.prompt,
            aspectRatio: prompt.aspectRatio ?? '1:1',
          });
          const saved = await saveRunImage({
            runId,
            modelId: model.id,
            promptId: prompt.id,
            seed,
            bytes: img.bytes,
            ext: img.ext,
          });
          artifacts.push({
            modelId: model.id,
            promptId: prompt.id,
            seed,
            relativePath: saved.relativePath,
            latencyMs: img.latencyMs,
          });
          done += 1;
          yield {
            type: 'progress',
            done,
            total,
            modelId: model.id,
            promptId: prompt.id,
            ok: true,
          };
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') throw error;
          artifacts.push({
            modelId: model.id,
            promptId: prompt.id,
            seed,
            relativePath: '',
            error: error instanceof Error ? error.message : 'Generation failed',
          });
          done += 1;
          yield {
            type: 'progress',
            done,
            total,
            modelId: model.id,
            promptId: prompt.id,
            ok: false,
            message: error instanceof Error ? error.message : 'Generation failed',
          };
        }
      }
    }

    await writeArtifacts(runId, artifacts);

    if (req.autoJudge) {
      try {
        const judgeOrId = await resolveJudgeOpenrouterId(req.judgeModelId);
        const ratings = emptyPreferenceRatings(limitedSuite, meta.modelIds);

        for (const prompt of prompts) {
          assertNotAborted(signal);
          yield { type: 'judging', promptId: prompt.id };
          const candidates = artifacts
            .filter((a) => a.promptId === prompt.id && a.relativePath && !a.error)
            .map((a) => ({ modelId: a.modelId, relativePath: a.relativePath }));

          if (candidates.length < 1) continue;

          const auto = await judgePreference({
            judgeOpenrouterId: judgeOrId,
            prompt: prompt.prompt,
            candidates,
            runId,
          });

          const idx = ratings.findIndex((r) => r.prompt_id === prompt.id);
          if (idx >= 0) {
            ratings[idx] = applyAutoJudgeToRating(ratings[idx], auto);
          }
        }

        await writeRatings(runId, ratings);
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        meta.status = 'ready';
        meta.error = `Auto-judge failed: ${error instanceof Error ? error.message : 'unknown'}`;
        await writeRunMeta(runId, meta);
        yield { type: 'done', runId, meta };
        return;
      }
    }

    meta.status = 'ready';
    await writeRunMeta(runId, meta);
    yield { type: 'done', runId, meta };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      await writeArtifacts(runId, artifacts);
      meta.status = 'failed';
      meta.error = 'Stopped';
      await writeRunMeta(runId, meta);
      yield { type: 'cancelled', runId, message: 'Stopped' };
      return;
    }
    throw error;
  }
}
