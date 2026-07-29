import { existsSync, readFileSync } from 'node:fs';
import { getDatasetById, listDatasets, type DatasetRef } from '../../config/datasets';
import {
  fixtureDatasetPath,
  hashFile,
  localDatasetPath,
  vendoredDatasetPath,
} from './cache';
import { HfDatasetError } from './hf';
import type { EvalSample, LoadedDataset } from './types';
import type { VendoredDatasetFile } from './vendored';

/** Datasets that must not be committed (NC / incompatible). Local-only via fetcher. */
export const LOCAL_ONLY_DATASET_IDS = new Set(['indic-glue-iitp-mr-hi']);

function readVendoredFile(path: string): VendoredDatasetFile {
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as VendoredDatasetFile;
}

function resolveVendoredPath(datasetId: string): string | null {
  const committed = vendoredDatasetPath(datasetId);
  if (existsSync(committed)) return committed;
  const local = localDatasetPath(datasetId);
  if (existsSync(local)) return local;
  const fixture = fixtureDatasetPath(datasetId);
  if (existsSync(fixture)) return fixture;
  return null;
}

/**
 * Load a dataset offline from vendored JSON under datasets/.
 * HF network fetch is not used at runtime — regenerate via `yarn datasets:fetch`.
 */
export async function loadDataset(
  datasetId: string,
  options?: { maxSamples?: number; seed?: number; forceRefresh?: boolean },
): Promise<LoadedDataset> {
  const ref = getDatasetById(datasetId);
  if (!ref) {
    throw new Error(`Unknown dataset id: ${datasetId}`);
  }

  const maxSamples = options?.maxSamples ?? ref.maxSamples;
  const seed = options?.seed ?? ref.seed;

  const path = resolveVendoredPath(datasetId);
  if (!path) {
    if (LOCAL_ONLY_DATASET_IDS.has(datasetId)) {
      throw new HfDatasetError(
        `Dataset "${datasetId}" is not committed (license: CC-BY-NC / external terms). ` +
          `Accept the terms and run: yarn datasets:fetch --id=${datasetId} ` +
          `(writes datasets/local/, gitignored).`,
      );
    }
    throw new HfDatasetError(
      `Vendored dataset missing for "${datasetId}". Run: yarn datasets:fetch --id=${datasetId}`,
    );
  }

  const file = readVendoredFile(path);
  if (file.seed !== seed && options?.seed != null) {
    // Seeded subsample is frozen in the vendored file; requesting a different seed
    // would break reproducibility — refuse rather than silently diverge.
    throw new Error(
      `Vendored dataset ${datasetId} was pinned with seed=${file.seed}; requested seed=${seed}. Re-fetch to change.`,
    );
  }

  const samples: EvalSample[] = file.samples.slice(0, maxSamples).map((s) => ({
    id: s.id,
    input: s.input,
    gold: s.gold,
    meta: s.meta,
  }));

  if (samples.length === 0) {
    throw new HfDatasetError(`Vendored dataset ${datasetId} has no samples`);
  }

  return {
    datasetId: ref.id,
    label: ref.label,
    task: ref.task,
    metric: ref.metric,
    hfDataset: file.hfDataset,
    hfConfig: file.hfConfig,
    hfSplit: file.hfSplit,
    seed: file.seed,
    maxSamples: samples.length,
    samples,
    fromCache: true,
    revision: file.revision,
    revisionHash: hashFile(path),
    retrievedAt: file.retrieved_at,
    license: file.license,
    vendoredPath: path,
  };
}

export function previewDatasets() {
  return listDatasets().map((d) => ({
    id: d.id,
    label: d.label,
    task: d.task,
    metric: d.metric,
    hf: d.hf,
    maxSamples: d.maxSamples,
    seed: d.seed,
    notes: d.notes ?? null,
    localOnly: LOCAL_ONLY_DATASET_IDS.has(d.id),
  }));
}

export { HfDatasetError };
export type { DatasetRef };
export type { VendoredDatasetFile } from './vendored';
