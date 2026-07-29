import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getRepoRoot } from '@redrob/harness';
import type { ImageArtifact, ImagePreferenceRating, ImageRunMeta } from './types';

export const EVAL_ROOT = path.join(getRepoRoot(), 'eval');
export const SUITES_DIR = path.join(EVAL_ROOT, 'suites');
export const RUNS_DIR = path.join(EVAL_ROOT, 'runs');

const RUN_ID_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}_[a-z0-9-]+$/i;
const SAFE_SEGMENT_RE = /^[a-z0-9][a-z0-9._-]*$/i;

export function assertSafeRunId(runId: string): string {
  if (!runId || !RUN_ID_RE.test(runId)) {
    throw new Error('Invalid run id');
  }
  return runId;
}

export function assertSafeSegment(value: string, label = 'path segment'): string {
  if (!value || !SAFE_SEGMENT_RE.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

/** Encode catalog / OpenRouter ids for filesystem folders (slashes → __). */
export function encodeModelDir(modelId: string): string {
  const encoded = String(modelId)
    .replace(/^or\//, '')
    .replace(/\//g, '__')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return assertSafeSegment(encoded || 'model', 'model id');
}

export function runDir(runId: string): string {
  return path.join(RUNS_DIR, assertSafeRunId(runId));
}

export async function ensureRunsDir(): Promise<void> {
  await fs.mkdir(RUNS_DIR, { recursive: true });
}

export function makeRunId(suiteId: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const safeSuite = String(suiteId || 'suite')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${date}_${time}_${safeSuite || 'suite'}`;
}

export async function writeRunMeta(runId: string, meta: ImageRunMeta): Promise<void> {
  const dir = runDir(runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

export async function readRunMeta(runId: string): Promise<ImageRunMeta> {
  const raw = await fs.readFile(path.join(runDir(runId), 'meta.json'), 'utf8');
  return JSON.parse(raw) as ImageRunMeta;
}

export async function writeRatings(
  runId: string,
  ratings: ImagePreferenceRating[],
): Promise<void> {
  const dir = runDir(runId);
  await fs.mkdir(dir, { recursive: true });
  const body = ratings.map((row) => JSON.stringify(row)).join('\n');
  await fs.writeFile(path.join(dir, 'ratings.jsonl'), body ? `${body}\n` : '', 'utf8');
}

export async function readRatings(runId: string): Promise<ImagePreferenceRating[]> {
  try {
    const raw = await fs.readFile(path.join(runDir(runId), 'ratings.jsonl'), 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ImagePreferenceRating);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function writeArtifacts(
  runId: string,
  artifacts: ImageArtifact[],
): Promise<void> {
  const dir = runDir(runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'artifacts.json'),
    `${JSON.stringify(artifacts, null, 2)}\n`,
    'utf8',
  );
}

export async function readArtifacts(runId: string): Promise<ImageArtifact[]> {
  try {
    const raw = await fs.readFile(path.join(runDir(runId), 'artifacts.json'), 'utf8');
    return JSON.parse(raw) as ImageArtifact[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function saveRunImage(params: {
  runId: string;
  modelId: string;
  promptId: string;
  seed: number;
  bytes: Buffer;
  ext?: string;
}): Promise<{ relativePath: string; filename: string }> {
  const modelDir = encodeModelDir(params.modelId);
  const promptId = assertSafeSegment(params.promptId, 'prompt id');
  const seed = assertSafeSegment(String(params.seed), 'seed');
  const ext = assertSafeSegment((params.ext ?? 'png').replace(/^\./, ''), 'extension');
  const dir = path.join(runDir(params.runId), modelDir);
  await fs.mkdir(dir, { recursive: true });
  const filename = `${promptId}_seed${seed}.${ext}`;
  await fs.writeFile(path.join(dir, filename), params.bytes);
  return {
    relativePath: `${modelDir}/${filename}`,
    filename,
  };
}

/** Resolve a file under the run dir; rejects path traversal. */
export function resolveRunFile(runId: string, relativePath: string): string {
  const cleaned = String(relativePath ?? '')
    .replace(/^[/\\]+/, '')
    .replace(/\\/g, '/');
  if (!cleaned || cleaned.includes('..')) {
    throw new Error('Invalid file path');
  }
  const abs = path.join(runDir(runId), ...cleaned.split('/'));
  const root = runDir(runId);
  if (!abs.startsWith(root + path.sep) && abs !== root) {
    throw new Error('Invalid file path');
  }
  return abs;
}

export async function listRunIds(): Promise<string[]> {
  await ensureRunsDir();
  const entries = await fs.readdir(RUNS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && RUN_ID_RE.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
}

export async function listRunImagePaths(runId: string): Promise<
  { modelDir: string; relativePath: string; filename: string }[]
> {
  const root = runDir(runId);
  const out: { modelDir: string; relativePath: string; filename: string }[] = [];
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const files = await fs.readdir(path.join(root, entry.name));
    for (const filename of files) {
      if (!/\.(png|jpe?g|webp)$/i.test(filename)) continue;
      out.push({
        modelDir: entry.name,
        filename,
        relativePath: `${entry.name}/${filename}`,
      });
    }
  }
  return out;
}
