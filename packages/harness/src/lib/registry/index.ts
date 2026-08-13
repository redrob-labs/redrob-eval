import path from 'node:path';

import { evalRoot } from '../paths';

import { FsRunStore } from './fs-store';
import { SqliteRunStore } from './sqlite-store';
import type { RunStore } from './types';

/**
 * Which store to use is configuration, not a decision baked into the code.
 *
 * A single researcher on a laptop and a shared lab machine want different
 * answers, and neither should have to fork anything to get one. The interface
 * is the fixed part; the driver behind it is a setting.
 *
 *   REDROB_REGISTRY_DRIVER   fs (default) | sqlite
 *   REDROB_REGISTRY_PATH     directory for fs, file for sqlite
 *
 * Postgres is the obvious third driver and deliberately absent: nothing here
 * needs a server yet, and an unused driver is a maintenance cost that grows.
 * It slots in behind the same interface when a shared deployment actually
 * wants it.
 */

export type RegistryDriver = 'fs' | 'sqlite';

export interface RegistryConfig {
  driver?: RegistryDriver;
  /** Directory for `fs`, file path for `sqlite`. Defaults under `eval/`. */
  path?: string;
}

export function defaultRegistryPath(driver: RegistryDriver): string {
  return driver === 'sqlite'
    ? path.join(evalRoot(), 'registry.sqlite')
    : path.join(evalRoot(), 'registry');
}

/** Config from the environment, so nothing has to be threaded through callers. */
export function registryConfigFromEnv(env = process.env): RegistryConfig {
  const raw = env.REDROB_REGISTRY_DRIVER?.trim().toLowerCase();
  if (raw && raw !== 'fs' && raw !== 'sqlite') {
    throw new Error(`REDROB_REGISTRY_DRIVER must be fs or sqlite, got "${raw}"`);
  }
  const config: RegistryConfig = { driver: (raw as RegistryDriver) || 'fs' };
  const location = env.REDROB_REGISTRY_PATH?.trim();
  if (location) config.path = location;
  return config;
}

export async function createRunStore(config: RegistryConfig = {}): Promise<RunStore> {
  const fromEnv = registryConfigFromEnv();
  const driver = config.driver ?? fromEnv.driver ?? 'fs';
  const location = config.path ?? fromEnv.path ?? defaultRegistryPath(driver);
  return driver === 'sqlite' ? SqliteRunStore.open(location) : new FsRunStore(location);
}

export { FsRunStore } from './fs-store';
export { SqliteRunStore } from './sqlite-store';
export { applyFilter, matchesFilter } from './filter';
export {
  assertSafeRunId,
  captureProvenance,
  gitDirty,
  gitSha,
  hashParams,
  makeRunId,
} from './provenance';
export { isTerminal, TERMINAL_STATUSES } from './types';
export type {
  Json,
  NewRun,
  NewRunEvent,
  Provenance,
  RunEvent,
  RunFilter,
  RunPatch,
  RunRecord,
  RunStatus,
  RunStore,
} from './types';
