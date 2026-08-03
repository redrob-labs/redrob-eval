import { promises as fs } from 'node:fs';
import path from 'node:path';
import { evalRoot } from '../paths';
import type { RunManifest } from '../jobs/manifest';
import type {
  Generation,
  PreferenceProgressEvent,
  PreferenceRun,
  PreferenceRunSummary,
} from './types';

function preferenceRunsDir(): string {
  return path.join(evalRoot(), 'preference-runs');
}

const RUN_ID_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}_[a-z0-9-]+$/i;

export function assertSafePreferenceRunId(runId: string): string {
  if (!runId || !RUN_ID_RE.test(runId)) throw new Error('Invalid preference run id');
  return runId;
}

export function makePreferenceRunId(taskId: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const safe = String(taskId || 'pref')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${date}_${time}_${safe || 'pref'}`;
}

export function preferenceRunDir(runId: string): string {
  return path.join(preferenceRunsDir(), assertSafePreferenceRunId(runId));
}

export async function ensurePreferenceDirs(): Promise<void> {
  await fs.mkdir(preferenceRunsDir(), { recursive: true });
}

export async function writePreferenceMeta(run: PreferenceRun): Promise<void> {
  await ensurePreferenceDirs();
  const dir = preferenceRunDir(run.id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'meta.json'), `${JSON.stringify(run, null, 2)}\n`, 'utf8');
}

export async function readPreferenceMeta(runId: string): Promise<PreferenceRun> {
  const raw = await fs.readFile(path.join(preferenceRunDir(runId), 'meta.json'), 'utf8');
  return JSON.parse(raw) as PreferenceRun;
}

export async function appendPreferenceGeneration(
  runId: string,
  generation: Generation,
): Promise<void> {
  const dir = preferenceRunDir(runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(
    path.join(dir, 'generations.jsonl'),
    `${JSON.stringify(generation)}\n`,
    'utf8',
  );
}

export async function readPreferenceGenerations(runId: string): Promise<Generation[]> {
  try {
    const raw = await fs.readFile(
      path.join(preferenceRunDir(assertSafePreferenceRunId(runId)), 'generations.jsonl'),
      'utf8',
    );
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Generation);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

export async function writePreferenceSummary(
  runId: string,
  summary: PreferenceRunSummary,
): Promise<void> {
  const dir = preferenceRunDir(runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8',
  );
}

export async function readPreferenceSummary(
  runId: string,
): Promise<PreferenceRunSummary | null> {
  try {
    const raw = await fs.readFile(
      path.join(preferenceRunDir(assertSafePreferenceRunId(runId)), 'summary.json'),
      'utf8',
    );
    return JSON.parse(raw) as PreferenceRunSummary;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export async function appendPreferenceEvent(
  runId: string,
  event: PreferenceProgressEvent,
): Promise<void> {
  const dir = preferenceRunDir(runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(
    path.join(dir, 'progress.jsonl'),
    `${JSON.stringify(event)}\n`,
    'utf8',
  );
}

export async function readPreferenceEvents(
  runId: string,
  fromLine = 0,
): Promise<{ events: PreferenceProgressEvent[]; nextLine: number }> {
  try {
    const raw = await fs.readFile(
      path.join(preferenceRunDir(assertSafePreferenceRunId(runId)), 'progress.jsonl'),
      'utf8',
    );
    const lines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const slice = lines.slice(fromLine);
    return {
      events: slice.map((l) => JSON.parse(l) as PreferenceProgressEvent),
      nextLine: fromLine + slice.length,
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { events: [], nextLine: fromLine };
    }
    throw e;
  }
}

export async function writePreferenceManifest(
  runId: string,
  manifest: RunManifest,
): Promise<void> {
  const dir = preferenceRunDir(runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'run_manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

export async function listPreferenceRunIds(): Promise<string[]> {
  await ensurePreferenceDirs();
  const entries = await fs.readdir(preferenceRunsDir(), { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && RUN_ID_RE.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
}

export async function patchPreferenceStatus(
  runId: string,
  status: PreferenceRun['status'],
  patch?: Partial<PreferenceRun>,
): Promise<PreferenceRun> {
  const meta = await readPreferenceMeta(runId);
  const next: PreferenceRun = { ...meta, ...patch, status, id: runId };
  if (status === 'ready' || status === 'failed' || status === 'stopped') {
    next.finishedAt = new Date().toISOString();
  }
  await writePreferenceMeta(next);
  return next;
}
