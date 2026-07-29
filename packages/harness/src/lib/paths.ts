import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the monorepo root (directory containing apps/ + packages/).
 * Works whether the process cwd is the repo root or apps/web.
 */
export function getRepoRoot(): string {
  // packages/harness/src/lib → repo root is four levels up
  const fromModule = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  if (isRepoRoot(fromModule)) return fromModule;

  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (isRepoRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function isRepoRoot(dir: string): boolean {
  return (
    existsSync(path.join(dir, 'packages', 'harness')) &&
    existsSync(path.join(dir, 'apps', 'web'))
  );
}

export function datasetsDir(): string {
  return path.join(getRepoRoot(), 'datasets');
}

export function evalRoot(): string {
  return path.join(getRepoRoot(), 'eval');
}
