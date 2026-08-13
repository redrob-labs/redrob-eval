import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { getRepoRoot } from '../paths';

import type { Json, NewRun, Provenance } from './types';

/**
 * Provenance is captured, not asked for.
 *
 * A field the caller has to remember to fill in is a field that is empty on the
 * run you most need it for. Everything here is read from the machine at the
 * moment the run opens.
 */

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: getRepoRoot(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // Not a checkout, or no git on the box. Recording null is honest; guessing
    // a sha would be worse than admitting the run cannot be placed in history.
    return null;
  }
}

export function gitSha(): string | null {
  return git(['rev-parse', 'HEAD']);
}

export function gitDirty(): boolean {
  const status = git(['status', '--porcelain']);
  return status == null ? false : status.length > 0;
}

/**
 * Key-order-independent hash of what was asked for.
 *
 * Two runs configured the same way have to land on the same hash however the
 * object was built, or "have I run this already" silently answers no.
 */
export function hashParams(params: Json): string {
  return createHash('sha256').update(stableStringify(params)).digest('hex').slice(0, 16);
}

function stableStringify(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k]!)}`).join(',')}}`;
}

export function captureProvenance(run: NewRun): Provenance {
  const captured: Provenance = {
    gitSha: gitSha(),
    gitDirty: gitDirty(),
    paramsHash: hashParams(run.params),
    models: run.models ?? [],
    runtime: { node: process.version, platform: process.platform },
  };
  if (run.datasetId) captured.datasetId = run.datasetId;
  if (run.datasetRevision) captured.datasetRevision = run.datasetRevision;
  // Tests pin these; ordinary callers should let them be read from the machine.
  return { ...captured, ...run.provenance };
}

/**
 * `2026-08-13_014210_tool-routing`: sortable by name, readable in a directory
 * listing, and short enough to paste into a paper.
 */
export function makeRunId(kind: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}_` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const slug = kind.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 32) || 'run';
  return `${stamp}_${slug}`;
}

const RUN_ID_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}_[a-z0-9-]+$/i;

/**
 * Ids reach the filesystem driver as a directory name, so they are validated
 * rather than trusted, the way tournament ids already are.
 */
export function assertSafeRunId(id: string): string {
  if (!id || !RUN_ID_RE.test(id)) throw new Error(`Invalid run id: ${id}`);
  return id;
}
