import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelEntry, PublicModelEntry } from '../types';

const REGISTRY_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'models.json',
);

let cached: ModelEntry[] | null = null;

function validateEntry(raw: unknown, index: number): ModelEntry {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`compare registry entry ${index}: expected object`);
  }
  const e = raw as ModelEntry;
  if (!e.id || !e.provider || !e.rates) {
    throw new Error(`compare registry entry ${index}: missing id/provider/rates`);
  }
  if (!Number.isFinite(e.rates.input) || !Number.isFinite(e.rates.output)) {
    throw new Error(`compare registry entry ${e.id}: rates.input/output must be finite`);
  }
  if (!Array.isArray(e.sources)) {
    throw new Error(`compare registry entry ${e.id}: sources[] required`);
  }
  return e;
}

/** Full registry including internal rates — server-side / offline verify only. */
export function loadCompareRegistry(options?: { refresh?: boolean }): ModelEntry[] {
  if (cached && !options?.refresh) return cached;
  const raw = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as unknown;
  if (!Array.isArray(raw)) throw new Error('compare registry must be a JSON array');
  cached = raw.map(validateEntry);
  return cached;
}

export function getCompareModel(id: string): ModelEntry | undefined {
  return loadCompareRegistry().find((m) => m.id === id);
}

/** Strip rates so nothing currency-shaped reaches the browser. */
export function toPublicRegistryEntry(e: ModelEntry): PublicModelEntry {
  return {
    id: e.id,
    label: e.label,
    provider: e.provider,
    contextWindow: e.contextWindow,
    openWeights: e.openWeights,
    published: e.published,
    sources: e.sources,
    hasCachedInputRate: e.rates.cachedInput !== undefined,
    hasPublishedLatency:
      e.published?.tokensPerSecond != null && e.published?.timeToFirstToken != null,
    hasArenaElo: e.published?.arenaElo != null,
    hasBenchmarkComposite: e.published?.benchmarkComposite != null,
  };
}

export function listPublicCompareRegistry(): PublicModelEntry[] {
  return loadCompareRegistry().map(toPublicRegistryEntry);
}

export function compareRegistryPath(): string {
  return REGISTRY_PATH;
}
