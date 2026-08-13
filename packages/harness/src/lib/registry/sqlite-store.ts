import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { applyFilter } from './filter';
import { assertSafeRunId, captureProvenance, makeRunId } from './provenance';
import { assertSafeArtifactName } from './types';
import type {
  Json,
  NewRun,
  NewRunEvent,
  RunEvent,
  RunFilter,
  RunPatch,
  RunRecord,
  RunStatus,
  RunStore,
} from './types';

/**
 * Runs in one SQLite file.
 *
 * For the researcher with thousands of runs, where listing them means reading
 * thousands of small files. `node:sqlite` ships with the runtime, so this costs
 * no dependency - but it is still experimental, so it is imported only when
 * this driver is actually configured. Nobody on the default path pays for it,
 * in load time or in warnings.
 *
 * Rows keep the module payloads as JSON text. The registry has never read them
 * and this driver is not the place to start: the moment they became columns,
 * adding a kind of run would mean a migration.
 */

/** The slice of `node:sqlite` used here, so the import can stay dynamic. */
interface Db {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  status       TEXT NOT NULL,
  label        TEXT,
  tags         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  started_at   TEXT,
  finished_at  TEXT,
  provenance   TEXT NOT NULL,
  params       TEXT NOT NULL,
  summary      TEXT,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS runs_kind_created ON runs (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS runs_status ON runs (status);
CREATE TABLE IF NOT EXISTS run_events (
  run_id   TEXT NOT NULL,
  seq      INTEGER NOT NULL,
  at       TEXT NOT NULL,
  level    TEXT NOT NULL,
  message  TEXT NOT NULL,
  data     TEXT,
  PRIMARY KEY (run_id, seq)
);
CREATE TABLE IF NOT EXISTS run_artifacts (
  run_id  TEXT NOT NULL,
  name    TEXT NOT NULL,
  data    TEXT NOT NULL,
  PRIMARY KEY (run_id, name)
);
`;

type Row = {
  id: string;
  kind: string;
  status: string;
  label: string | null;
  tags: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  provenance: string;
  params: string;
  summary: string | null;
  error: string | null;
};

function toRecord(row: Row): RunRecord {
  const run: RunRecord = {
    id: row.id,
    kind: row.kind,
    status: row.status as RunStatus,
    tags: JSON.parse(row.tags) as string[],
    createdAt: row.created_at,
    provenance: JSON.parse(row.provenance) as RunRecord['provenance'],
    params: JSON.parse(row.params) as Json,
  };
  if (row.label) run.label = row.label;
  if (row.started_at) run.startedAt = row.started_at;
  if (row.finished_at) run.finishedAt = row.finished_at;
  if (row.summary) run.summary = JSON.parse(row.summary) as Json;
  if (row.error) run.error = row.error;
  return run;
}

export class SqliteRunStore implements RunStore {
  readonly driver = 'sqlite';

  private constructor(private db: Db) {}

  /**
   * Async because the driver is imported on demand.
   *
   * The specifier goes through a variable so it is resolved by the runtime
   * rather than the type checker: `node:sqlite` ships without type
   * declarations, and a static import would fail the build for everyone,
   * including the majority who never configure this driver.
   */
  static async open(file: string): Promise<SqliteRunStore> {
    mkdirSync(path.dirname(file), { recursive: true });
    const specifier = 'node:sqlite';
    const sqlite = (await import(specifier)) as {
      DatabaseSync: new (p: string) => Db;
    };
    const db = new sqlite.DatabaseSync(file);
    db.exec(SCHEMA);
    return new SqliteRunStore(db);
  }

  async create(input: NewRun): Promise<RunRecord> {
    const now = new Date();
    const status = input.status ?? 'running';
    let id = makeRunId(input.kind, now);
    for (let n = 2; this.rowFor(id); n += 1) {
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
    this.insert(run);
    return run;
  }

  private insert(run: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, kind, status, label, tags, created_at, started_at,
                           finished_at, provenance, params, summary, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.kind,
        run.status,
        run.label ?? null,
        JSON.stringify(run.tags),
        run.createdAt,
        run.startedAt ?? null,
        run.finishedAt ?? null,
        JSON.stringify(run.provenance),
        JSON.stringify(run.params),
        run.summary === undefined ? null : JSON.stringify(run.summary),
        run.error ?? null,
      );
  }

  private rowFor(id: string): Row | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
    return row ?? null;
  }

  async get(id: string): Promise<RunRecord | null> {
    const row = this.rowFor(assertSafeRunId(id));
    return row ? toRecord(row) : null;
  }

  /**
   * Narrow in SQL where it is cheap, then hand the result to the same predicate
   * the filesystem driver uses. Reimplementing tag and search semantics in SQL
   * is how two drivers start disagreeing.
   */
  private candidates(filter: RunFilter = {}): RunRecord[] {
    const where: string[] = [];
    const args: unknown[] = [];
    const kinds = filter.kind == null ? [] : ([] as string[]).concat(filter.kind);
    if (kinds.length) {
      where.push(`kind IN (${kinds.map(() => '?').join(',')})`);
      args.push(...kinds);
    }
    const statuses = filter.status == null ? [] : ([] as string[]).concat(filter.status);
    if (statuses.length) {
      where.push(`status IN (${statuses.map(() => '?').join(',')})`);
      args.push(...statuses);
    }
    if (filter.createdAfter) {
      where.push('created_at >= ?');
      args.push(filter.createdAfter);
    }
    if (filter.createdBefore) {
      where.push('created_at <= ?');
      args.push(filter.createdBefore);
    }
    const sql = `SELECT * FROM runs${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
    return (this.db.prepare(sql).all(...args) as Row[]).map(toRecord);
  }

  async list(filter?: RunFilter): Promise<RunRecord[]> {
    return applyFilter(this.candidates(filter), filter);
  }

  async count(filter?: RunFilter): Promise<number> {
    const { limit: _limit, offset: _offset, ...rest } = filter ?? {};
    return applyFilter(this.candidates(rest), rest).length;
  }

  async update(id: string, patch: RunPatch): Promise<RunRecord> {
    const current = await this.get(id);
    if (!current) throw new Error(`Unknown run: ${id}`);
    const next: RunRecord = { ...current };
    if (patch.status !== undefined) next.status = patch.status;
    if (patch.label !== undefined) next.label = patch.label;
    if (patch.tags !== undefined) next.tags = patch.tags;
    if (patch.summary !== undefined) next.summary = patch.summary;
    if (patch.error !== undefined) next.error = patch.error;
    if (patch.startedAt !== undefined) next.startedAt = patch.startedAt;
    if (patch.finishedAt !== undefined) next.finishedAt = patch.finishedAt;
    if (patch.status === 'running' && !next.startedAt) next.startedAt = new Date().toISOString();
    if (
      patch.status &&
      (patch.status === 'done' || patch.status === 'failed' || patch.status === 'cancelled') &&
      !patch.finishedAt
    ) {
      next.finishedAt = new Date().toISOString();
    }

    this.db
      .prepare(
        `UPDATE runs SET status = ?, label = ?, tags = ?, started_at = ?, finished_at = ?,
                         summary = ?, error = ? WHERE id = ?`,
      )
      .run(
        next.status,
        next.label ?? null,
        JSON.stringify(next.tags),
        next.startedAt ?? null,
        next.finishedAt ?? null,
        next.summary === undefined ? null : JSON.stringify(next.summary),
        next.error ?? null,
        next.id,
      );
    return next;
  }

  async appendEvents(id: string, events: NewRunEvent[]): Promise<void> {
    if (events.length === 0) return;
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM run_events WHERE run_id = ?')
      .get(id) as { n: number };
    let seq = Number(row?.n ?? 0);
    const insert = this.db.prepare(
      'INSERT INTO run_events (run_id, seq, at, level, message, data) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const e of events) {
      seq += 1;
      insert.run(
        id,
        seq,
        e.at ?? new Date().toISOString(),
        e.level,
        e.message,
        e.data === undefined ? null : JSON.stringify(e.data),
      );
    }
  }

  async readEvents(id: string): Promise<RunEvent[]> {
    const rows = this.db
      .prepare('SELECT seq, at, level, message, data FROM run_events WHERE run_id = ? ORDER BY seq')
      .all(id) as Array<{
      seq: number;
      at: string;
      level: string;
      message: string;
      data: string | null;
    }>;
    return rows.map((r) => ({
      seq: Number(r.seq),
      at: r.at,
      level: r.level as RunEvent['level'],
      message: r.message,
      ...(r.data == null ? {} : { data: JSON.parse(r.data) as Json }),
    }));
  }

  async putArtifact(id: string, name: string, data: Json): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO run_artifacts (run_id, name, data) VALUES (?, ?, ?)
         ON CONFLICT (run_id, name) DO UPDATE SET data = excluded.data`,
      )
      .run(id, assertSafeArtifactName(name), JSON.stringify(data));
  }

  async readArtifact(id: string, name: string): Promise<Json | null> {
    const row = this.db
      .prepare('SELECT data FROM run_artifacts WHERE run_id = ? AND name = ?')
      .get(id, assertSafeArtifactName(name)) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Json) : null;
  }

  async listArtifacts(id: string): Promise<string[]> {
    const rows = this.db
      .prepare('SELECT name FROM run_artifacts WHERE run_id = ? ORDER BY name')
      .all(id) as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  async close(): Promise<void> {
    try {
      this.db.close();
    } catch {
      // Already closed.
    }
  }
}
