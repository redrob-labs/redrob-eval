/**
 * In-process job registry for local-first routing collection.
 * Survives browser refresh because work continues server-side and events are on disk.
 */
import { resolveEvalModel } from '../catalog/resolve';
import { loadDataset } from '../datasets';
import { getDatasetById } from '../../config/datasets';
import type { EvalStreamEvent } from '../eval/types';
import {
  runRoutingCollection,
  type RoutingCollectRequest,
} from '../routing-data/collect';
import {
  ensureRoutingDirs,
  makeRoutingRunId,
  writeRoutingMeta,
} from '../routing-data/fs';
import type { RoutingRunMeta } from '../routing-data/types';
import { defaultSmallOkThreshold } from '../routing-data/labels';
import { appendProgressEvent, writeRunManifest, writeJobStatus } from './fs';
import { buildRunManifest } from './manifest-helpers';

type JobRecord = {
  runId: string;
  abort: AbortController;
  promise: Promise<void>;
};

const jobs = new Map<string, JobRecord>();

export function getActiveJob(runId: string): JobRecord | undefined {
  return jobs.get(runId);
}

export function abortJob(runId: string): boolean {
  const job = jobs.get(runId);
  if (!job) return false;
  job.abort.abort();
  return true;
}

/**
 * Start a routing collection job in the background. Returns runId immediately.
 * Progress is appended to progress.jsonl; clients subscribe via SSE events route.
 */
export async function startRoutingCollectJob(
  req: RoutingCollectRequest,
): Promise<{ runId: string }> {
  const datasetRef = getDatasetById(req.datasetId);
  if (!datasetRef) throw new Error(`Unknown dataset id: ${req.datasetId}`);

  const small = await resolveEvalModel(req.smallModelId);
  const large = await resolveEvalModel(req.largeModelId);
  if (!small || !large) throw new Error('Provide valid smallModelId and largeModelId');
  if (small.id === large.id) throw new Error('Small and large models must differ');

  await ensureRoutingDirs();
  const runId = makeRoutingRunId(datasetRef.id);
  const startedAt = new Date().toISOString();
  const sampleCount = Math.min(
    Math.max(1, Math.floor(req.sampleCount)),
    datasetRef.maxSamples,
  );

  const loaded = await loadDataset(req.datasetId, { maxSamples: sampleCount });
  const threshold = req.smallOkThreshold ?? defaultSmallOkThreshold(datasetRef.metric);

  const meta: RoutingRunMeta = {
    runId,
    createdAt: startedAt,
    status: 'queued',
    datasetId: datasetRef.id,
    datasetLabel: datasetRef.label,
    task: datasetRef.task,
    metric: datasetRef.metric,
    sampleCount: Math.min(sampleCount, loaded.samples.length),
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
  await writeRunManifest(
    runId,
    buildRunManifest({
      seed: loaded.seed,
      temperature: 0,
      small,
      large,
      dataset: loaded,
      startedAtUtc: startedAt,
      finishedAtUtc: null,
      maxRollouts: null,
    }),
  );

  const abort = new AbortController();
  const promise = (async () => {
    await writeJobStatus(runId, 'running');
    try {
      for await (const event of runRoutingCollection(
        {
          datasetId: req.datasetId,
          sampleCount: req.sampleCount,
          smallModelId: req.smallModelId,
          largeModelId: req.largeModelId,
          smallOkThreshold: req.smallOkThreshold,
        },
        { signal: abort.signal, runId },
      )) {
        await appendProgressEvent(runId, event);
        if (event.type === 'error') {
          await writeJobStatus(runId, 'failed');
          break;
        }
        if (event.type === 'cancelled') {
          await writeJobStatus(runId, 'stopped');
          break;
        }
        if (event.type === 'done') {
          await writeJobStatus(runId, 'ready', {
            finishedAt: new Date().toISOString(),
          });
          await writeRunManifest(
            runId,
            buildRunManifest({
              seed: loaded.seed,
              temperature: 0,
              small,
              large,
              dataset: loaded,
              startedAtUtc: startedAt,
              finishedAtUtc: new Date().toISOString(),
              maxRollouts: null,
            }),
          );
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Collection failed';
      const cancelled = err instanceof Error && err.name === 'AbortError';
      const event: EvalStreamEvent = cancelled
        ? { type: 'cancelled', message: 'Stopped' }
        : { type: 'error', message };
      await appendProgressEvent(runId, event);
      await writeJobStatus(runId, cancelled ? 'stopped' : 'failed');
    } finally {
      jobs.delete(runId);
    }
  })();

  jobs.set(runId, { runId, abort, promise });
  return { runId };
}
