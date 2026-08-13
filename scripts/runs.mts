/**
 * Look at what has been run.
 *
 * The registry is only worth having if answering "what did I run yesterday, and
 * what happened to it" takes one command rather than a directory dig.
 *
 *   yarn runs                                  # the last 20, newest first
 *   yarn runs --kind tool-routing --status failed
 *   yarn runs --tag paper --limit 50
 *   yarn runs --search granite
 *   yarn runs show 2026-08-13_014210_tool-routing
 *   yarn runs show <id> --events
 *   yarn runs show <id> --json
 *
 * The driver is whatever REDROB_REGISTRY_DRIVER says, so this reads the same
 * store the app writes to.
 */
import { createRunStore } from '@redrob/harness';
import type { RunFilter, RunRecord, RunStatus } from '@redrob/harness';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** `2026-08-13T01:42:10.000Z` is not what anyone wants in a list. */
function ago(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  const units: Array<[number, string]> = [
    [60, 's'],
    [60, 'm'],
    [24, 'h'],
    [365, 'd'],
  ];
  let value = seconds;
  let unit = 's';
  for (const [size, next] of units) {
    if (value < size) break;
    value /= size;
    unit = next;
  }
  return `${Math.round(value)}${unit} ago`;
}

function duration(run: RunRecord): string {
  if (!run.startedAt) return '—';
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
  const seconds = Math.max(0, (end - Date.parse(run.startedAt)) / 1000);
  if (seconds < 90) return `${seconds.toFixed(0)}s`;
  if (seconds < 5400) return `${(seconds / 60).toFixed(0)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

const MARK: Record<RunStatus, string> = {
  queued: '·',
  running: '>',
  done: 'ok',
  failed: 'FAIL',
  cancelled: 'x',
};

/** Pad to a width but never truncate: a clipped id is one you cannot copy. */
function pad(text: string, width: number): string {
  return text.length >= width ? text : text.padEnd(width);
}

// Piping `yarn runs` into `head` closes stdout early; that is a normal way to
// use a listing, not a crash. Exit quietly when the reader hangs up.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

const store = await createRunStore();
try {
  const [command, maybeId] = process.argv.slice(2).filter((a) => !a.startsWith('--'));

  if (command === 'show') {
    if (!maybeId) {
      console.error('Usage: yarn runs show <run id>');
      process.exit(2);
    }
    const run = await store.get(maybeId);
    if (!run) {
      console.error(`No run with id ${maybeId}`);
      process.exit(1);
    }
    if (flag('json')) {
      console.log(JSON.stringify(run, null, 2));
    } else {
      console.log(`${run.id}  [${run.status}]${run.label ? `  ${run.label}` : ''}`);
      console.log(`  kind        ${run.kind}`);
      console.log(`  created     ${run.createdAt} (${ago(run.createdAt)})`);
      console.log(`  took        ${duration(run)}`);
      if (run.tags.length) console.log(`  tags        ${run.tags.join(', ')}`);
      const p = run.provenance;
      console.log(`  commit      ${p.gitSha ?? 'unknown'}${p.gitDirty ? ' (dirty)' : ''}`);
      console.log(`  params hash ${p.paramsHash}`);
      if (p.models.length) console.log(`  models      ${p.models.join(', ')}`);
      if (p.datasetId) {
        console.log(`  dataset     ${p.datasetId}${p.datasetRevision ? `@${p.datasetRevision}` : ''}`);
      }
      console.log(`  runtime     ${p.runtime.node} ${p.runtime.platform}`);
      if (run.error) console.log(`  error       ${run.error}`);
      console.log(`  params      ${JSON.stringify(run.params)}`);
      if (run.summary !== undefined) {
        console.log(`  summary     ${JSON.stringify(run.summary)}`);
      }
    }
    if (flag('events')) {
      const events = await store.readEvents(run.id);
      console.log(`\n${events.length} event(s)`);
      for (const e of events) {
        console.log(`  ${String(e.seq).padStart(4)} ${e.level.padEnd(5)} ${e.message}`);
      }
    }
  } else {
    const filter: RunFilter = { limit: Number(arg('limit') ?? '20') || 20 };
    const kind = arg('kind');
    if (kind) filter.kind = kind;
    const status = arg('status');
    if (status) filter.status = status as RunStatus;
    const tag = arg('tag');
    if (tag) filter.tags = tag.split(',').map((t) => t.trim()).filter(Boolean);
    const search = arg('search');
    if (search) filter.search = search;
    const model = arg('model');
    if (model) filter.model = model;

    const runs = await store.list(filter);
    const total = await store.count({ ...filter, limit: undefined, offset: undefined });
    if (runs.length === 0) {
      console.log(`No runs matched (store: ${store.driver}).`);
    } else {
      for (const run of runs) {
        console.log(
          `${pad(MARK[run.status], 4)} ${pad(run.id, 34)} ${pad(run.kind, 14)} ` +
            `${pad(duration(run), 6)} ${pad(ago(run.createdAt), 9)} ${run.label ?? ''}`,
        );
      }
      console.log(`\n${runs.length} of ${total} run(s) · store: ${store.driver}`);
    }
  }
} finally {
  await store.close();
}
