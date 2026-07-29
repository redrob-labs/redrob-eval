import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { datasetsDir, getRepoRoot } from '../paths';

const CACHE_ROOT = join(getRepoRoot(), '.cache', 'datasets');

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function cacheKey(parts: Record<string, string | number | boolean | undefined>): string {
  const normalized = Object.keys(parts)
    .sort()
    .map((k) => `${k}=${String(parts[k] ?? '')}`)
    .join('&');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

export function readJsonCache<T>(key: string): T | null {
  const path = join(CACHE_ROOT, `${key}.json`);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeJsonCache(key: string, value: unknown): void {
  ensureDir(CACHE_ROOT);
  const path = join(CACHE_ROOT, `${key}.json`);
  writeFileSync(path, JSON.stringify(value), 'utf8');
}

export function getCacheRoot(): string {
  return CACHE_ROOT;
}

/** Content hash of a vendored dataset file (for run_manifest). */
export function hashFile(filePath: string): string {
  const raw = readFileSync(filePath);
  return createHash('sha256').update(raw).digest('hex');
}

export function vendoredDatasetPath(datasetId: string): string {
  return join(datasetsDir(), `${datasetId}.json`);
}

export function localDatasetPath(datasetId: string): string {
  return join(datasetsDir(), 'local', `${datasetId}.json`);
}

export function fixtureDatasetPath(datasetId: string): string {
  return join(datasetsDir(), 'fixtures', `${datasetId}.json`);
}
