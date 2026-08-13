import { readCheckpointedCells, runStoreCheckpoint } from '../queue/checkpoint';
import { expandMatrix } from '../queue/matrix';
import { runMatrix } from '../queue/queue';
import type { Cell, MatrixResult, QueueProgress } from '../queue/types';
import { hashParams } from '../registry/provenance';
import type { Json, RunRecord, RunStore } from '../registry/types';

/**
 * The glue that makes the registry and the queue one thing.
 *
 * On its own the queue runs cells and the registry stores runs; a researcher
 * wants a single verb - run this grid, and if it dies, run it again and pick up
 * where it stopped. This is that verb. It opens (or reopens) a registry run,
 * checkpoints every cell to that run's event log, and drives the queue against
 * it. The three blocks were built to snap together here.
 */

export interface RegistryMatrixParams<TSummary = Json> {
  store: RunStore;
  /** Registry `kind` for the run, e.g. `tool-routing-matrix`. */
  kind: string;
  dimensions: Record<string, Json[]>;
  /** Dimension whose value caps a group's concurrency, usually a provider. */
  groupBy?: string;
  /**
   * The work for one cell. `runId` is handed over because a worker usually
   * wants to attach its own evidence - a full report, a transcript - to the run
   * it is part of, and it cannot know the id any other way while still running.
   */
  worker: (
    cell: Cell,
    ctx: { attempt: number; signal: AbortSignal; runId: string },
  ) => Promise<TSummary>;
  label?: string;
  tags?: string[];
  models?: string[];
  datasetId?: string;
  /** Recorded alongside the dimensions, and folded into the params hash. */
  extraParams?: Record<string, Json>;
  concurrency?: number;
  perGroupConcurrency?: number;
  maxAttempts?: number;
  signal?: AbortSignal;
  onProgress?: (progress: QueueProgress & { runId: string }) => void;
  /**
   * Reopen this run instead of creating one. The dimensions must hash to the
   * same value the run was created with, so a resume cannot quietly become a
   * different experiment sharing an id.
   */
  resume?: string;
}

export interface RegistryMatrixResult<TSummary = Json> {
  runId: string;
  run: RunRecord;
  result: MatrixResult<TSummary>;
}

export async function runRegistryMatrix<TSummary = Json>(
  params: RegistryMatrixParams<TSummary>,
): Promise<RegistryMatrixResult<TSummary>> {
  const runParams: Json = { dimensions: params.dimensions, ...(params.extraParams ?? {}) };
  const cells = expandMatrix({ dimensions: params.dimensions, groupBy: params.groupBy });

  let run: RunRecord;
  if (params.resume) {
    const existing = await params.store.get(params.resume);
    if (!existing) throw new Error(`Cannot resume: no run with id ${params.resume}`);
    // A resume that quietly ran a different grid under the same id would be the
    // worst kind of reproducibility bug, so the question has to match.
    if (existing.provenance.paramsHash !== hashParams(runParams)) {
      throw new Error(
        `Cannot resume ${params.resume}: its parameters differ from the ones given. ` +
          'Start a new run, or pass the same dimensions.',
      );
    }
    run = await params.store.update(params.resume, { status: 'running' });
  } else {
    run = await params.store.create({
      kind: params.kind,
      params: runParams,
      status: 'running',
      ...(params.label ? { label: params.label } : {}),
      ...(params.tags ? { tags: params.tags } : {}),
      ...(params.models ? { models: params.models } : {}),
      ...(params.datasetId ? { datasetId: params.datasetId } : {}),
    });
  }

  const checkpoint = runStoreCheckpoint(params.store, run.id);
  let result: MatrixResult<TSummary>;
  try {
    result = await runMatrix<TSummary>({
      cells,
      worker: (cell, ctx) => params.worker(cell, { ...ctx, runId: run.id }),
      checkpoint,
      ...(params.concurrency !== undefined ? { concurrency: params.concurrency } : {}),
      ...(params.perGroupConcurrency !== undefined
        ? { perGroupConcurrency: params.perGroupConcurrency }
        : {}),
      ...(params.maxAttempts !== undefined ? { maxAttempts: params.maxAttempts } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
      onProgress: params.onProgress
        ? (p) => params.onProgress!({ ...p, runId: run.id })
        : undefined,
    });
  } catch (error) {
    // runMatrix isolates per-cell failures, so reaching here means the whole
    // drive broke. Record that the run failed rather than leaving it 'running'.
    const message = error instanceof Error ? error.message : String(error);
    run = await params.store.update(run.id, { status: 'failed', error: message });
    throw error;
  }

  // A grid with some failed cells still finished; only a cancel or a total
  // collapse is not 'done'. The counts live in the summary either way.
  const status = result.cancelled ? 'cancelled' : 'done';
  run = await params.store.update(run.id, {
    status,
    summary: {
      total: cells.length,
      done: result.done,
      failed: result.failed,
      resumed: result.resumed,
    },
  });

  return { runId: run.id, run, result };
}

/** The finished grid, read back from the registry as a table of cells. */
export async function readMatrixCells(store: RunStore, runId: string) {
  return readCheckpointedCells(store, runId);
}
