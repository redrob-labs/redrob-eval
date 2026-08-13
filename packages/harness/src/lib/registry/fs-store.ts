import { promises as fs } from 'node:fs';
import path from 'node:path';

import { applyFilter } from './filter';
import { assertSafeRunId, captureProvenance, makeRunId } from './provenance';
import type {
  NewRun,
  NewRunEvent,
  RunEvent,
  RunFilter,
  RunPatch,
  RunRecord,
  RunStore,
} from './types';

/**
 * Runs on disk, one directory each.
 *
 * The default driver, because it needs nothing installed and nothing running,
 * and because it is the layout the rest of the repo already uses: a JSON
 * snapshot beside an append-only JSONL log, the same shape as
 * `eval/tournaments/`. A researcher can read a run with `cat`, diff two of
 * them, and commit one to a paper repo. That is worth more at this size than
 * query speed.
 *
 *   <root>/<run id>/run.json
 *   <root>/<run id>/events.jsonl
 */
export class FsRunStore implements RunStore {
  readonly driver = 'fs';

  constructor(private readonly root: string) {}

  private dir(id: string): string {
    return path.join(this.root, assertSafeRunId(id));
  }

  private async write(run: RunRecord): Promise<void> {
    const dir = this.dir(run.id);
    await fs.mkdir(dir, { recursive: true });
    // Written whole. A partial patch on disk would be a run that half-happened.
    await fs.writeFile(
      path.join(dir, 'run.json'),
      `${JSON.stringify(run, null, 2)}\n`,
      'utf8',
    );
  }

  async create(input: NewRun): Promise<RunRecord> {
    const now = new Date();
    const status = input.status ?? 'running';
    let id = makeRunId(input.kind, now);
    // Two runs opened in the same second would otherwise land in one directory.
    for (let n = 2; await this.exists(id); n += 1) {
      id = `${makeRunId(input.kind, now)}-${n}`;
      if (n > 50) throw new Error('could not allocate a free run id');
    }

    const run: RunRecord = {
      id,
      kind: input.kind,
      status,
      tags: input.tags ?? [],
      createdAt: now.toISOString(),
      provenance: captureProvenance(input),
      params: input.params,
    };
    if (input.label) run.label = input.label;
    if (status === 'running') run.startedAt = run.createdAt;
    await this.write(run);
    return run;
  }

  private async exists(id: string): Promise<boolean> {
    try {
      await fs.access(path.join(this.root, id, 'run.json'));
      return true;
    } catch {
      return false;
    }
  }

  async get(id: string): Promise<RunRecord | null> {
    try {
      const raw = await fs.readFile(path.join(this.dir(id), 'run.json'), 'utf8');
      return JSON.parse(raw) as RunRecord;
    } catch {
      return null;
    }
  }

  private async all(): Promise<RunRecord[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.root);
    } catch {
      return [];
    }
    const runs: RunRecord[] = [];
    for (const entry of entries) {
      try {
        const raw = await fs.readFile(path.join(this.root, entry, 'run.json'), 'utf8');
        runs.push(JSON.parse(raw) as RunRecord);
      } catch {
        // A directory that is not a run, or a run half-written by a crash.
        // Skipping beats refusing to list everything else.
      }
    }
    return runs;
  }

  async list(filter?: RunFilter): Promise<RunRecord[]> {
    return applyFilter(await this.all(), filter);
  }

  async count(filter?: RunFilter): Promise<number> {
    // Paging must not change the count, so the page window is dropped.
    const { limit: _limit, offset: _offset, ...rest } = filter ?? {};
    return applyFilter(await this.all(), rest).length;
  }

  async update(id: string, patch: RunPatch): Promise<RunRecord> {
    const current = await this.get(id);
    if (!current) throw new Error(`Unknown run: ${id}`);
    const next: RunRecord = { ...current, ...stripUndefined(patch) };
    // Timestamps are bookkeeping the caller should not have to remember.
    if (patch.status === 'running' && !next.startedAt) next.startedAt = new Date().toISOString();
    if (patch.status && isOver(patch.status) && !patch.finishedAt) {
      next.finishedAt = new Date().toISOString();
    }
    await this.write(next);
    return next;
  }

  async appendEvents(id: string, events: NewRunEvent[]): Promise<void> {
    if (events.length === 0) return;
    const dir = this.dir(id);
    await fs.mkdir(dir, { recursive: true });
    const existing = await this.readEvents(id);
    let seq = existing.length;
    const lines = events
      .map((e) => {
        seq += 1;
        const row: RunEvent = {
          seq,
          at: e.at ?? new Date().toISOString(),
          level: e.level,
          message: e.message,
          ...(e.data === undefined ? {} : { data: e.data }),
        };
        return `${JSON.stringify(row)}\n`;
      })
      .join('');
    await fs.appendFile(path.join(dir, 'events.jsonl'), lines, 'utf8');
  }

  async readEvents(id: string): Promise<RunEvent[]> {
    try {
      const raw = await fs.readFile(path.join(this.dir(id), 'events.jsonl'), 'utf8');
      return raw
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as RunEvent);
    } catch {
      return [];
    }
  }

  async close(): Promise<void> {
    // Nothing held open.
  }
}

function isOver(status: RunPatch['status']): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}
