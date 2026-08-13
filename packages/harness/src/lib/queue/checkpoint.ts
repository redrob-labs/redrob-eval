import type { RunStore } from '../registry/types';

import type { Checkpoint, CellOutcome } from './types';

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
      await store.appendEvents(runId, [
        {
          level: outcome.status === 'done' ? 'info' : 'error',
          message: CELL_EVENT,
          data: {
            cell: outcome.key,
            status: outcome.status,
            attempts: outcome.attempts,
            ...(outcome.error ? { error: outcome.error } : {}),
          },
        },
      ]);
    },
  };
}
