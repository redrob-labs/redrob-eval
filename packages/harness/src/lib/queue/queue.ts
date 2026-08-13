import type {
  Cell,
  CellOutcome,
  MatrixResult,
  QueueProgress,
  RunMatrixParams,
} from './types';

/** Default backoff: 0.5s, 1s, 2s, … capped, so a retry storm cannot run away. */
function defaultBackoff(retry: number): number {
  return Math.min(30_000, 500 * 2 ** (retry - 1));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    const onAbort = () => finish();
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run a grid of cells under a concurrency budget, checkpointing as it goes.
 *
 * The scheduler is a fixed set of workers pulling from a shared cursor rather
 * than a promise per cell, so a thousand-cell grid holds a handful of inflight
 * calls, not a thousand. A cell is admitted only when both the global budget
 * and its group's budget have room, which is what keeps one provider's rate
 * limit from being tripped by fanning out across models that share it.
 *
 * Resume is checked once up front: cells the checkpoint already has are emitted
 * as outcomes and never handed to a worker. Everything the queue itself decides
 * - which cells ran, how many attempts, why one failed - it also records, so the
 * next invocation sees the same picture.
 */
export async function runMatrix<TSummary = unknown>(
  params: RunMatrixParams<TSummary>,
): Promise<MatrixResult<TSummary>> {
  const concurrency = Math.max(1, params.concurrency ?? 4);
  const perGroup = Math.max(1, params.perGroupConcurrency ?? concurrency);
  const maxAttempts = Math.max(1, params.maxAttempts ?? 1);
  const backoff = params.backoffMs ?? defaultBackoff;
  const signal = params.signal ?? new AbortController().signal;

  const outcomes = new Map<string, CellOutcome<TSummary>>();
  const alreadyDone = (await params.checkpoint?.completedKeys()) ?? new Set<string>();

  // Resume: settle the finished cells before any worker starts, so progress
  // and the final tally count them without re-running them.
  const pending: Cell[] = [];
  for (const cell of params.cells) {
    if (alreadyDone.has(cell.key)) {
      outcomes.set(cell.key, {
        key: cell.key,
        status: 'done',
        attempts: 0,
        resumed: true,
      });
    } else {
      pending.push(cell);
    }
  }

  const total = params.cells.length;
  let done = [...outcomes.values()].filter((o) => o.status === 'done').length;
  let failed = 0;
  const resumed = done;
  let running = 0;

  const report = (cell?: CellOutcome<TSummary>) => {
    const progress: QueueProgress = { done, failed, resumed, running, total };
    if (cell) progress.cell = cell as CellOutcome;
    params.onProgress?.(progress);
  };
  report();

  const groupInflight = new Map<string, number>();
  let cursor = 0;

  /** The next cell whose group has room, or null if none can start right now. */
  function claim(): Cell | null {
    for (let i = cursor; i < pending.length; i += 1) {
      const cell = pending[i]!;
      const group = cell.group;
      const inflight = group ? (groupInflight.get(group) ?? 0) : 0;
      if (!group || inflight < perGroup) {
        // Swap the claimed cell to the cursor so it is not scanned again, then
        // advance. Order within a group is not promised, only its cap.
        pending[i] = pending[cursor]!;
        pending[cursor] = cell;
        cursor += 1;
        if (group) groupInflight.set(group, inflight + 1);
        return cell;
      }
    }
    return null;
  }

  async function runCell(cell: Cell): Promise<void> {
    let attempt = 0;
    let lastError = 'failed';
    while (attempt < maxAttempts && !signal.aborted) {
      attempt += 1;
      try {
        const summary = await params.worker(cell, { attempt, signal });
        const outcome: CellOutcome<TSummary> = {
          key: cell.key,
          status: 'done',
          summary,
          attempts: attempt,
          resumed: false,
        };
        outcomes.set(cell.key, outcome);
        done += 1;
        await params.checkpoint?.record(outcome as CellOutcome);
        report(outcome);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < maxAttempts && !signal.aborted) {
          await sleep(backoff(attempt), signal);
        }
      }
    }
    // Aborted mid-cell leaves no outcome: the cell is neither done nor failed,
    // so a resume will run it again rather than record a failure nobody caused.
    if (signal.aborted && !outcomes.has(cell.key)) return;
    const outcome: CellOutcome<TSummary> = {
      key: cell.key,
      status: 'failed',
      error: lastError,
      attempts: attempt,
      resumed: false,
    };
    outcomes.set(cell.key, outcome);
    failed += 1;
    await params.checkpoint?.record(outcome as CellOutcome);
    report(outcome);
  }

  // A worker loops until nothing is claimable. It returns null only when every
  // remaining cell is group-blocked - and a group is blocked only by a cell
  // some other worker still holds, which that worker will loop back and drain.
  // So the worker holding the last cell of a saturated group is always the one
  // that goes on to claim its siblings; no cell is orphaned by an early exit,
  // and a single pass of `concurrency` workers is enough.
  async function worker(): Promise<void> {
    for (;;) {
      if (signal.aborted) return;
      const cell = claim();
      if (!cell) return;
      running += 1;
      report();
      try {
        await runCell(cell);
      } finally {
        running -= 1;
        if (cell.group) {
          groupInflight.set(cell.group, (groupInflight.get(cell.group) ?? 1) - 1);
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()),
  );

  const ordered = params.cells.map(
    (c) =>
      outcomes.get(c.key) ?? {
        key: c.key,
        status: 'failed' as const,
        error: 'not run',
        attempts: 0,
        resumed: false,
      },
  );
  // A cell with no outcome only exists when the run was aborted before it ran.
  const settled = params.cells.filter((c) => outcomes.has(c.key)).length;
  return {
    outcomes: ordered.filter((o) => outcomes.has(o.key)),
    done,
    failed,
    resumed,
    cancelled: signal.aborted && settled < total,
  };
}
