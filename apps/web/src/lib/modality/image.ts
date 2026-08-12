import { resolveModel, type EvalStreamEvent, type EvalTargetSummary } from '@redrob/harness';
import { generateOpenRouterImage } from '@/lib/image-eval/generate';
import { judgePreference } from '@/lib/image-eval/judge';
import {
  ensureRunsDir,
  makeRunId,
  saveRunImage,
  writeArtifacts,
  writeRunMeta,
} from '@/lib/image-eval/fs';
import { loadSuite } from '@/lib/image-eval/suite';
import type { ImageArtifact, ImageRunMeta } from '@/lib/image-eval/types';
import type { ModalityAdapter, ModalityPrompt, ModalityRunRequest } from './types';

/** URL the browser can load a generated image from. */
function artifactUrl(runId: string, relativePath: string): string {
  return `/api/image/runs/${encodeURIComponent(runId)}?file=${encodeURIComponent(relativePath)}`;
}

/** Inverse of `artifactUrl` — the judge reads bytes off disk, not over HTTP. */
function parseArtifactUrl(url: string): { runId: string; relativePath: string } | null {
  const m = /^\/api\/image\/runs\/([^/?]+)\?file=(.+)$/.exec(url);
  if (!m) return null;
  return { runId: decodeURIComponent(m[1]!), relativePath: decodeURIComponent(m[2]!) };
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('Stopped');
    err.name = 'AbortError';
    throw err;
  }
}

async function resolvePrompts(req: ModalityRunRequest): Promise<ModalityPrompt[]> {
  const given = (req.prompts ?? []).filter((p) => p.input?.trim());
  if (given.length) return given.slice(0, req.sampleCount);

  const suite = await loadSuite(req.suiteId ?? 'sfw-core');
  if (!suite) throw new Error(`Unknown image suite: ${req.suiteId ?? 'sfw-core'}`);
  return suite.prompts
    .slice(0, Math.max(1, req.sampleCount))
    .map((p) => ({ id: p.id, input: p.prompt }));
}

/**
 * Image answers are generated files, so there is nothing to score against —
 * every image run resolves through the preference tournament instead.
 */
async function* runImage(
  req: ModalityRunRequest,
  opts?: { signal?: AbortSignal },
): AsyncGenerator<EvalStreamEvent, void, unknown> {
  const signal = opts?.signal;

  let prompts: ModalityPrompt[];
  try {
    prompts = await resolvePrompts(req);
  } catch (e) {
    yield { type: 'error', message: e instanceof Error ? e.message : 'No prompts' };
    return;
  }
  if (!prompts.length) {
    yield { type: 'error', message: 'Add at least one image prompt' };
    return;
  }

  const models = [];
  for (const id of req.modelIds) {
    const m = await resolveModel(id);
    if (!m) {
      yield { type: 'error', message: `Unknown model: ${id}` };
      return;
    }
    models.push(m);
  }
  if (!models.length) {
    yield { type: 'error', message: 'Select at least one image generator' };
    return;
  }

  const seed = Number.isFinite(req.seed) ? Number(req.seed) : 42;
  await ensureRunsDir();
  const runId = makeRunId(req.suiteId ?? 'compare');
  const meta: ImageRunMeta = {
    runId,
    suiteId: req.suiteId ?? 'compare',
    createdAt: new Date().toISOString(),
    seed,
    modelIds: models.map((m) => m.canonicalId),
    modelLabels: Object.fromEntries(models.map((m) => [m.canonicalId, m.label])),
    promptIds: prompts.map((p) => p.id),
    status: 'running',
    scoring: 'preference',
  };
  await writeRunMeta(runId, meta);

  const totalCalls = prompts.length * models.length;
  yield {
    type: 'start',
    runId,
    datasetId: meta.suiteId,
    sampleCount: prompts.length,
    targets: models.map((m) => ({
      targetId: m.canonicalId,
      label: m.label,
      kind: 'model' as const,
    })),
    totalCalls,
    scored: false,
  };

  const artifacts: ImageArtifact[] = [];
  const summaries: EvalTargetSummary[] = [];
  let done = 0;

  try {
    for (const model of models) {
      const sampleResults: EvalTargetSummary['sampleResults'] = [];
      const latencies: number[] = [];

      for (let i = 0; i < prompts.length; i += 1) {
        assertNotAborted(signal);
        const prompt = prompts[i]!;
        try {
          const img = await generateOpenRouterImage({
            openrouterModelId: model.modelId,
            prompt: prompt.input,
          });
          const saved = await saveRunImage({
            runId,
            modelId: model.canonicalId,
            promptId: prompt.id,
            seed,
            bytes: img.bytes,
            ext: img.ext,
          });
          artifacts.push({
            modelId: model.canonicalId,
            promptId: prompt.id,
            seed,
            relativePath: saved.relativePath,
            latencyMs: img.latencyMs,
          });
          latencies.push(img.latencyMs);
          sampleResults.push({
            sampleId: prompt.id,
            score: 0,
            latencyMs: img.latencyMs,
            prediction: artifactUrl(runId, saved.relativePath),
          });
          done += 1;
          yield {
            type: 'progress',
            done,
            total: totalCalls,
            targetId: model.canonicalId,
            sampleIndex: i,
            sampleId: prompt.id,
            latencyMs: img.latencyMs,
            prediction: artifactUrl(runId, saved.relativePath),
          };
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') throw error;
          const message = error instanceof Error ? error.message : 'Generation failed';
          artifacts.push({
            modelId: model.canonicalId,
            promptId: prompt.id,
            seed,
            relativePath: '',
            error: message,
          });
          sampleResults.push({
            sampleId: prompt.id,
            score: 0,
            latencyMs: 0,
            prediction: '',
            error: message,
          });
          done += 1;
          yield {
            type: 'progress',
            done,
            total: totalCalls,
            targetId: model.canonicalId,
            sampleIndex: i,
            sampleId: prompt.id,
            error: message,
          };
        }
      }

      const summary: EvalTargetSummary = {
        targetId: model.canonicalId,
        label: model.label,
        kind: 'model',
        metric: 'llm_judge',
        n: sampleResults.length,
        quality: 0,
        meanLatencyMs: latencies.length
          ? latencies.reduce((a, b) => a + b, 0) / latencies.length
          : 0,
        meanRelativeCost: 0,
        relativeCostPct: 0,
        sampleResults,
        caveat: `image generation; provider=${model.providerId}; model=${model.modelId}; n=${sampleResults.length}; ranked by human preference`,
        meanTtftMs: null,
        tokensPerSec: null,
      };
      summaries.push(summary);
      yield { type: 'target_done', target: summary };
    }

    await writeArtifacts(runId, artifacts);
    meta.status = 'ready';
    await writeRunMeta(runId, meta);

    yield {
      type: 'done',
      result: {
        meta: {
          runId,
          datasetId: meta.suiteId,
          datasetLabel: req.promptSetLabel || meta.suiteId,
          task: 'custom',
          metric: 'llm_judge',
          sampleCount: prompts.length,
          seed,
          largeBaselineId: null,
          finishedAt: new Date().toISOString(),
          scored: false,
          prompts: prompts.map((p) => ({ id: p.id, input: p.input })),
        },
        targets: summaries,
        routingLog: [],
      },
    };
  } catch (error) {
    await writeArtifacts(runId, artifacts);
    meta.status = 'failed';
    meta.error = error instanceof Error ? error.message : 'Image run failed';
    await writeRunMeta(runId, meta);
    if (error instanceof Error && error.name === 'AbortError') {
      yield { type: 'cancelled', message: 'Stopped' };
      return;
    }
    yield { type: 'error', message: meta.error };
  }
}

export const imageModality: ModalityAdapter = {
  id: 'image',
  label: 'Image',
  answerKind: 'image',
  autoScorable: false,
  catalogFilter: 'image',
  run: runImage,
  async judgeMatch({ promptText, a, b, judgeModelId }) {
    const pa = parseArtifactUrl(a.answer);
    const pb = parseArtifactUrl(b.answer);
    if (!pa || !pb || pa.runId !== pb.runId) {
      throw new Error('Both images must come from the same run to be judged');
    }

    const auto = await judgePreference({
      judgeOpenrouterId: judgeModelId?.trim() || 'openai/gpt-4o',
      prompt: promptText,
      runId: pa.runId,
      candidates: [
        { modelId: a.modelId, relativePath: pa.relativePath },
        { modelId: b.modelId, relativePath: pb.relativePath },
      ],
    });

    const winner =
      auto.winner === a.modelId ? 'a' : auto.winner === b.modelId ? 'b' : 'tie';
    return { winner, rationale: auto.rationale };
  },
};
