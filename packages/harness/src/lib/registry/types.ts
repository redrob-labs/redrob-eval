/**
 * The experiment registry.
 *
 * Every module here already produces runs - an eval, a preference tournament, a
 * tool-routing sweep, a multi-turn transcript - and each invented its own way to
 * store them. That is fine until someone asks the questions a researcher asks
 * every day: what did I run yesterday, what changed since, which cells failed,
 * and can I reproduce it. Those questions are about runs in general, not about
 * any one module.
 *
 * So the registry holds one small record that every kind of run shares, and
 * treats what the module actually did as opaque. The shared part is what makes
 * runs listable, comparable and citable; the opaque part is what keeps the
 * registry from having to know about brackets, toolsets or turn depth. New kinds
 * of run plug in without the registry changing - the block interlocks, it does
 * not get rebuilt.
 */

/** Anything JSON-serialisable. Module payloads are held, never interpreted. */
export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** Runs that are over, whichever way they ended. */
export const TERMINAL_STATUSES: RunStatus[] = ['done', 'failed', 'cancelled'];

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * What has to be true to believe a number again later.
 *
 * Deliberately only machine and repository facts. No rater, author or account:
 * the tournament log already refuses to record who voted, and a registry that
 * quietly reintroduced identity next to it would undo that.
 */
export interface Provenance {
  /** Commit the code was at, or null outside a git checkout. */
  gitSha: string | null;
  /** Uncommitted changes were present, so the sha does not fully describe it. */
  gitDirty: boolean;
  /**
   * Stable hash of `params`. Two runs with the same hash asked the same
   * question, which is what makes "has this already been run" answerable.
   */
  paramsHash: string;
  /** Models involved, so a run can be found by what it exercised. */
  models: string[];
  /** Dataset or fixture set, with a revision when the source has one. */
  datasetId?: string;
  datasetRevision?: string;
  /** Runtime, because a result that only reproduces on one of them is a finding. */
  runtime: { node: string; platform: string };
}

export interface RunRecord {
  /** Sortable and quotable: `2026-08-13_014210_tool-routing`. */
  id: string;
  /** Which module produced it. Free-form so a new module needs no schema change. */
  kind: string;
  status: RunStatus;
  /** Short human name. The id stays the thing you cite. */
  label?: string;
  tags: string[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  provenance: Provenance;
  /** What was asked for. Module-shaped; the registry does not read it. */
  params: Json;
  /** Headline numbers. Module-shaped; the registry does not read it. */
  summary?: Json;
  /** Set when the run ended badly, in the module's own words. */
  error?: string;
}

/** Everything needed to open a run. The registry fills in the rest. */
export interface NewRun {
  kind: string;
  params: Json;
  label?: string;
  tags?: string[];
  models?: string[];
  datasetId?: string;
  datasetRevision?: string;
  /** Start `queued` when a scheduler will pick it up later. Defaults to running. */
  status?: Extract<RunStatus, 'queued' | 'running'>;
  /** Overrides the captured provenance. Tests pin it; callers should not. */
  provenance?: Partial<Provenance>;
}

export interface RunPatch {
  status?: RunStatus;
  label?: string;
  tags?: string[];
  summary?: Json;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

/** A line in a run's log: progress, a warning, whatever the module wants kept. */
export interface RunEvent {
  /** 1-based, assigned by the store, so ordering survives equal timestamps. */
  seq: number;
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  data?: Json;
}

export type NewRunEvent = Omit<RunEvent, 'seq' | 'at'> & { at?: string };

export interface RunFilter {
  kind?: string | string[];
  status?: RunStatus | RunStatus[];
  /** A run matches when it carries every tag listed. */
  tags?: string[];
  /** Find the runs that asked the same question. */
  paramsHash?: string;
  model?: string;
  /** ISO instants, inclusive. */
  createdAfter?: string;
  createdBefore?: string;
  /** Substring of id or label, case-insensitive. */
  search?: string;
  limit?: number;
  offset?: number;
}

/**
 * Storage for runs.
 *
 * One interface, several drivers, chosen by configuration: a single researcher
 * on a laptop and a shared lab database should not be different products.
 */
export interface RunStore {
  /** Which driver answered, so a surprising result can be traced to its store. */
  readonly driver: string;
  create(run: NewRun): Promise<RunRecord>;
  get(id: string): Promise<RunRecord | null>;
  /** Newest first. */
  list(filter?: RunFilter): Promise<RunRecord[]>;
  count(filter?: RunFilter): Promise<number>;
  update(id: string, patch: RunPatch): Promise<RunRecord>;
  appendEvents(id: string, events: NewRunEvent[]): Promise<void>;
  readEvents(id: string): Promise<RunEvent[]>;
  /** Release handles. Safe to call more than once. */
  close(): Promise<void>;
}
