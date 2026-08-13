import type { Json, RunStore } from '../registry/types';

import type { Checkpoint, CellOutcome, CellStatus } from './types';

/**
 * A checkpoint kept in memory. For tests, and for a matrix nobody needs to
 * resume across processes.
 */
export class MemoryCheckpoint implements Checkpoint {
  private readonly done = new Set<string>();
  readonly recorded: CellOutcome[] = [];

  async completedKeys(): Promise<Set<string>> {
    return new Set(this.done);
  }

  async record(outcome: CellOutcome): Promise<void> {
    this.recorded.push(outcome);
    if (outcome.status === 'done') this.done.add(outcome.key);
  }
}

const CELL_EVENT = 'cell';

/**
 * A checkpoint backed by a registry run's event log.
 *
 * Each finished cell is one appended event carrying its key and outcome. Resume
 * reads the log back and treats a cell as done when its last event says so - the
 * last, because a cell can fail, be retried in a later invocation, and succeed,
 * and the log is a history, not a set. Reusing the event log rather than adding
 * a table is the point: the registry already promises append-only durability,
 * and a matrix is just a run with a lot of small events.
 */
/** One cell's last recorded outcome, read back from a run's event log. */
export interface CheckpointedCell {
  key: string;
  status: CellStatus;
  attempts: number;
  error?: string;
  summary?: Json;
}

/**
 * Every cell's last word, folded from a run's events.
 *
 * Lets a results table be rebuilt from the registry without re-running
 * anything - the numbers a cancelled-then-resumed matrix produced are all here,
 * whichever process produced them.
 */
export async function readCheckpointedCells(
  store: RunStore,
  runId: string,
): Promise<CheckpointedCell[]> {
  const events = await store.readEvents(runId);
  const byKey = new Map<string, CheckpointedCell>();
  for (const event of events) {
    if (event.message !== CELL_EVENT) continue;
    const data = event.data as
      | { cell?: string; status?: string; attempts?: number; error?: string; summary?: Json }
      | undefined;
    if (!data?.cell || (data.status !== 'done' && data.status !== 'failed')) continue;
    const cell: CheckpointedCell = {
      key: data.cell,
      status: data.status,
      attempts: Number(data.attempts ?? 0),
    };
    if (data.error !== undefined) cell.error = data.error;
    if (data.summary !== undefined) cell.summary = data.summary;
    byKey.set(data.cell, cell);
  }
  return [...byKey.values()];
}

export function runStoreCheckpoint(store: RunStore, runId: string): Checkpoint {
  return {
    async completedKeys(): Promise<Set<string>> {
      const events = await store.readEvents(runId);
      // Fold the history: the last word on each key wins, so a key that failed
      // and later succeeded counts as done, and one that succeeded and was
      // somehow rerun to failure does not.
      const lastStatus = new Map<string, string>();
      for (const event of events) {
        const data = event.data as { cell?: string; status?: string } | undefined;
        if (event.message === CELL_EVENT && data?.cell && data.status) {
          lastStatus.set(data.cell, data.status);
        }
      }
      const done = new Set<string>();
      for (const [key, status] of lastStatus) if (status === 'done') done.add(key);
      return done;
    },

    async record(outcome: CellOutcome): Promise<void> {
      // The summary rides along, so a results table can be rebuilt from the run
      // even after a resume: the cells that finished in an earlier process left
      // their numbers here, not only in that process's memory.
      await store.appendEvents(runId, [
        {
          level: outcome.status === 'done' ? 'info' : 'error',
          message: CELL_EVENT,
          data: {
            cell: outcome.key,
            status: outcome.status,
            attempts: outcome.attempts,
            ...(outcome.error ? { error: outcome.error } : {}),
            ...(outcome.summary === undefined ? {} : { summary: outcome.summary }),
          },
        },
      ]);
    },
  };
}
