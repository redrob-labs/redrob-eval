import type { Json } from '../registry/types';

/**
 * A resumable job queue for run matrices.
 *
 * A researcher's real unit of work is not one run, it is a grid: these models,
 * over these datasets, in these languages, under these conditions. That grid
 * takes long enough that something will interrupt it - a laptop sleeps, a
 * provider rate-limits, a token budget runs out - and re-running the cells that
 * already finished is both a waste and a way to get inconsistent numbers.
 *
 * So the queue treats the grid as cells, runs them under a concurrency budget it
 * can actually keep (globally and per provider), and checkpoints each cell as it
 * lands. Interrupt it and start it again and it picks up only what is left. The
 * checkpoint is the registry's append-only event log, which is why that log
 * existed before there was anything writing to it.
 */

/** One square of the grid: a stable key and the parameters that define it. */
export interface Cell {
  /**
   * Identifies the cell across runs. Two invocations of the same matrix must
   * derive the same key for the same square, or resume cannot tell them apart.
   */
  key: string;
  /** What the worker is given. Opaque to the queue. */
  params: Json;
  /**
   * Which shared limit this cell draws on, usually a provider. Cells in the
   * same group never exceed that group's concurrency cap, so one provider's
   * rate limit cannot be tripped by fanning out across models that share it.
   */
  group?: string;
}

export type CellStatus = 'done' | 'failed';

/** What a finished cell leaves behind, for resume and for the final tally. */
export interface CellOutcome<TSummary = Json> {
  key: string;
  status: CellStatus;
  /** The worker's result. Present on success. */
  summary?: TSummary;
  /** Why it failed, after the last attempt. Present on failure. */
  error?: string;
  attempts: number;
  /** Skipped because a checkpoint already had it done. Not re-run. */
  resumed: boolean;
}

/**
 * Where cell outcomes are remembered between runs.
 *
 * Small on purpose: a store only has to say which cells are already done, and
 * accept new outcomes. The registry-backed adapter satisfies it with the event
 * log; a test satisfies it with a Map.
 */
export interface Checkpoint {
  /** Keys already finished successfully, so they are skipped on resume. */
  completedKeys(): Promise<Set<string>>;
  /** Persist one cell's outcome. Called once per cell that actually runs. */
  record(outcome: CellOutcome): Promise<void>;
}

export interface QueueProgress {
  done: number;
  failed: number;
  /** Cells skipped because the checkpoint already had them. */
  resumed: number;
  running: number;
  total: number;
  /** The cell that just changed state, when one did. */
  cell?: CellOutcome;
}

export interface RunMatrixParams<TSummary = Json> {
  cells: Cell[];
  /** The work. Throwing means the cell failed; returning is its summary. */
  worker: (cell: Cell, ctx: { attempt: number; signal: AbortSignal }) => Promise<TSummary>;
  /** How many cells may run at once across all groups. Default 4. */
  concurrency?: number;
  /** Per-group ceiling, so one provider's limit is respected. Default = concurrency. */
  perGroupConcurrency?: number;
  /**
   * How many times to try a failing cell before giving up. Default 1 (no
   * retry). A retry is for the transient failure - a 429, a dropped socket -
   * not for a cell that is wrong every time.
   */
  maxAttempts?: number;
  /** Backoff before attempt n (1-based retry index). Default exponential. */
  backoffMs?: (retry: number) => number;
  checkpoint?: Checkpoint;
  signal?: AbortSignal;
  onProgress?: (progress: QueueProgress) => void;
}

export interface MatrixResult<TSummary = Json> {
  outcomes: CellOutcome<TSummary>[];
  done: number;
  failed: number;
  resumed: number;
  /** True when the run was aborted before every cell reached a terminal state. */
  cancelled: boolean;
}
