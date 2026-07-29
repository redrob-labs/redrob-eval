import { promises as fs } from 'node:fs';
import path from 'node:path';
import { evalRoot } from '../paths';
import type { OptimizeEvent } from '../optimizer/types';
import type { RunManifest } from './manifest';

function optimizeRunsDir(): string {
  return path.join(evalRoot(), 'optimize-runs');
}

const RUN_ID_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}_[a-z0-9-]+$/i;

export function assertSafeOptimizeRunId(runId: string): string {
  if (!runId || !RUN_ID_RE.test(runId)) throw new Error('Invalid optimize run id');
  return runId;
}

export function makeOptimizeRunId(datasetId: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const safe = String(datasetId || 'dataset')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${date}_${time}_${safe || 'opt'}`;
}

export function optimizeRunDir(runId: string): string {
  return path.join(optimizeRunsDir(), assertSafeOptimizeRunId(runId));
}

export async function ensureOptimizeDirs(): Promise<void> {
  await fs.mkdir(optimizeRunsDir(), { recursive: true });
}

export interface OptimizeRunMeta {
  runId: string;
  createdAt: string;
  finishedAt?: string;
  status: 'queued' | 'running' | 'ready' | 'failed' | 'stopped';
  datasetId: string;
  optimizer: 'gepa' | 'random';
  qualityFloor: number;
  maxRollouts: number;
  seed: number;
  error?: string;
  optimizedAgainst: Array<'train' | 'val' | 'test'>;
  mode?: 'catalog' | 'custom' | 'checklist';
  customGoal?: {
    goal: string;
    rubric: string;
    exampleCount: number;
    exampleIds: string[];
    /** Rubric-shape lint warning surfaced to Evolve runners */
    rubricLint?: string;
  };
  judgeModelId?: string;
}

export async function writeOptimizeMeta(
  runId: string,
  meta: OptimizeRunMeta,
): Promise<void> {
  await ensureOptimizeDirs();
  const dir = optimizeRunDir(runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

export async function readOptimizeMeta(runId: string): Promise<OptimizeRunMeta> {
  const raw = await fs.readFile(path.join(optimizeRunDir(runId), 'meta.json'), 'utf8');
  return JSON.parse(raw) as OptimizeRunMeta;
}

export async function appendOptimizeEvent(
  runId: string,
  event: OptimizeEvent,
): Promise<void> {
  await ensureOptimizeDirs();
  const dir = optimizeRunDir(runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, 'progress.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
}

export async function readOptimizeEvents(
  runId: string,
  fromLine = 0,
): Promise<{ events: OptimizeEvent[]; nextLine: number }> {
  try {
    const raw = await fs.readFile(
      path.join(optimizeRunDir(assertSafeOptimizeRunId(runId)), 'progress.jsonl'),
      'utf8',
    );
    const lines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const slice = lines.slice(fromLine);
    return {
      events: slice.map((l) => JSON.parse(l) as OptimizeEvent),
      nextLine: fromLine + slice.length,
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { events: [], nextLine: fromLine };
    }
    throw e;
  }
}

export async function writeOptimizeResult(
  runId: string,
  result: unknown,
): Promise<void> {
  const dir = optimizeRunDir(runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'result.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  );
}

export async function readOptimizeResult(runId: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(
      path.join(optimizeRunDir(assertSafeOptimizeRunId(runId)), 'result.json'),
      'utf8',
    );
    return JSON.parse(raw);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export async function writeOptimizeManifest(
  runId: string,
  manifest: RunManifest,
): Promise<void> {
  const dir = optimizeRunDir(runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'run_manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

export async function writeOptimizeFrontier(
  runId: string,
  frontier: unknown,
): Promise<void> {
  const dir = optimizeRunDir(runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'frontier.json'),
    `${JSON.stringify(frontier, null, 2)}\n`,
    'utf8',
  );
}

export async function writeOptimizeReport(
  runId: string,
  report: unknown,
  markdown?: string,
): Promise<void> {
  const dir = optimizeRunDir(runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  if (markdown != null) {
    await fs.writeFile(path.join(dir, 'report.md'), markdown, 'utf8');
  }
}

export async function readOptimizeReport(runId: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(
      path.join(optimizeRunDir(assertSafeOptimizeRunId(runId)), 'report.json'),
      'utf8',
    );
    return JSON.parse(raw);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export async function readOptimizeReportMarkdown(
  runId: string,
): Promise<string | null> {
  try {
    return await fs.readFile(
      path.join(optimizeRunDir(assertSafeOptimizeRunId(runId)), 'report.md'),
      'utf8',
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export async function patchOptimizeStatus(
  runId: string,
  status: OptimizeRunMeta['status'],
  patch?: Partial<OptimizeRunMeta>,
): Promise<void> {
  const meta = await readOptimizeMeta(runId);
  const next: OptimizeRunMeta = { ...meta, ...patch, status, runId };
  if (status === 'ready' || status === 'failed' || status === 'stopped') {
    next.finishedAt = new Date().toISOString();
  }
  await writeOptimizeMeta(runId, next);
}

export async function listOptimizeRunIds(): Promise<string[]> {
  await ensureOptimizeDirs();
  const entries = await fs.readdir(optimizeRunsDir(), { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && RUN_ID_RE.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
}
