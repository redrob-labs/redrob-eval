import { promises as fs } from 'node:fs';
import path from 'node:path';
import { evalRoot, getRepoRoot } from '../paths';
import type {
  CorpusStats,
  RouteLabel,
  RoutingExample,
  RoutingRunMeta,
  RoutingRunSummary,
} from './types';

function evalRootPath(): string {
  return evalRoot();
}

/** @deprecated Prefer evalRoot() — kept for callers that read the constant. */
export const EVAL_ROOT = evalRootPath();
export const ROUTING_RUNS_DIR = path.join(EVAL_ROOT, 'routing-runs');
export const ROUTING_CORPUS_DIR = path.join(EVAL_ROOT, 'routing-corpus');
export const CORPUS_EXAMPLES_PATH = path.join(ROUTING_CORPUS_DIR, 'examples.jsonl');
export const CORPUS_STATS_PATH = path.join(ROUTING_CORPUS_DIR, 'stats.json');
export const LEARNINGS_PATH = path.join(getRepoRoot(), 'docs', 'learnings.md');

function runsDir(): string {
  return path.join(evalRootPath(), 'routing-runs');
}
function corpusDir(): string {
  return path.join(evalRootPath(), 'routing-corpus');
}
function corpusExamplesPath(): string {
  return path.join(corpusDir(), 'examples.jsonl');
}
function corpusStatsPath(): string {
  return path.join(corpusDir(), 'stats.json');
}

const RUN_ID_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}_[a-z0-9-]+$/i;

export function assertSafeRunId(runId: string): string {
  if (!runId || !RUN_ID_RE.test(runId)) throw new Error('Invalid routing run id');
  return runId;
}

export function makeRoutingRunId(datasetId: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const safe = String(datasetId || 'dataset')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${date}_${time}_${safe || 'dataset'}`;
}

export function routingRunDir(runId: string): string {
  return path.join(runsDir(), assertSafeRunId(runId));
}

export async function ensureRoutingDirs(): Promise<void> {
  await fs.mkdir(runsDir(), { recursive: true });
  await fs.mkdir(corpusDir(), { recursive: true });
}

export async function writeRoutingMeta(runId: string, meta: RoutingRunMeta): Promise<void> {
  const dir = routingRunDir(runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

export async function readRoutingMeta(runId: string): Promise<RoutingRunMeta> {
  const raw = await fs.readFile(path.join(routingRunDir(runId), 'meta.json'), 'utf8');
  return JSON.parse(raw) as RoutingRunMeta;
}

export async function appendRoutingExample(
  runId: string,
  example: RoutingExample,
): Promise<void> {
  const dir = routingRunDir(runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, 'examples.jsonl'), `${JSON.stringify(example)}\n`, 'utf8');
  await fs.mkdir(corpusDir(), { recursive: true });
  await fs.appendFile(corpusExamplesPath(), `${JSON.stringify(example)}\n`, 'utf8');
}

export async function readRoutingExamples(runId: string): Promise<RoutingExample[]> {
  try {
    const raw = await fs.readFile(path.join(routingRunDir(runId), 'examples.jsonl'), 'utf8');
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as RoutingExample);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

export async function writeRoutingSummary(
  runId: string,
  summary: RoutingRunSummary,
): Promise<void> {
  const dir = routingRunDir(runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8',
  );
}

export async function readRoutingSummary(runId: string): Promise<RoutingRunSummary | null> {
  try {
    const raw = await fs.readFile(path.join(routingRunDir(runId), 'summary.json'), 'utf8');
    return JSON.parse(raw) as RoutingRunSummary;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export async function listRoutingRunIds(): Promise<string[]> {
  await ensureRoutingDirs();
  const entries = await fs.readdir(runsDir(), { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && RUN_ID_RE.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
}

export async function readAllCorpusExamples(): Promise<RoutingExample[]> {
  try {
    const raw = await fs.readFile(corpusExamplesPath(), 'utf8');
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as RoutingExample);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

export async function computeAndWriteCorpusStats(): Promise<CorpusStats> {
  const examples = await readAllCorpusExamples();
  const byDataset: Record<string, number> = {};
  const byTask: Record<string, number> = {};
  const byLabel: Record<RouteLabel, number> = { small: 0, large: 0 };
  let lastUpdatedAt: string | null = null;

  for (const ex of examples) {
    byDataset[ex.datasetId] = (byDataset[ex.datasetId] ?? 0) + 1;
    byTask[ex.task] = (byTask[ex.task] ?? 0) + 1;
    byLabel[ex.label] += 1;
    if (!lastUpdatedAt || ex.createdAt > lastUpdatedAt) lastUpdatedAt = ex.createdAt;
  }

  const runIds = await listRoutingRunIds();
  const stats: CorpusStats = {
    exampleCount: examples.length,
    runCount: runIds.length,
    byDataset,
    byTask,
    byLabel,
    lastUpdatedAt,
  };
  await fs.mkdir(corpusDir(), { recursive: true });
  await fs.writeFile(corpusStatsPath(), `${JSON.stringify(stats, null, 2)}\n`, 'utf8');
  return stats;
}

export async function readCorpusStats(): Promise<CorpusStats> {
  try {
    const raw = await fs.readFile(corpusStatsPath(), 'utf8');
    return JSON.parse(raw) as CorpusStats;
  } catch {
    return computeAndWriteCorpusStats();
  }
}
