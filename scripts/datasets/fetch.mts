#!/usr/bin/env tsx
/**
 * Regenerate vendored datasets under datasets/.
 *
 *   yarn datasets:fetch
 *   yarn datasets:fetch --id=gsm8k-main
 *   yarn datasets:fetch --id=indic-glue-iitp-mr-hi   # writes datasets/local/ (gitignored)
 *
 * Not required to run the app — only to refresh pinned subsets.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EVAL_DATASETS,
  getDatasetById,
  type DatasetRef,
} from '../../packages/harness/src/config/datasets.ts';
import { fetchHfRows } from '../../packages/harness/src/lib/datasets/hf.ts';
import { seededSample } from '../../packages/harness/src/lib/datasets/seeded.ts';
import type { VendoredDatasetFile } from '../../packages/harness/src/lib/datasets/vendored.ts';

/** Must match packages/harness LOCAL_ONLY_DATASET_IDS */
const LOCAL_ONLY_DATASET_IDS = new Set(['indic-glue-iitp-mr-hi']);

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

const LICENSES: Record<string, string> = {
  'gsm8k-main': 'MIT',
  'in22-gen-hi-en': 'CC-BY-4.0',
  'indic-glue-iitp-mr-hi': 'CC-BY-NC-4.0 (IndicNLP Suite / external terms — local only)',
};

function fieldToString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function poolSizeFor(ref: DatasetRef): number {
  if (ref.poolSize != null) return Math.max(ref.poolSize, ref.maxSamples);
  return Math.min(Math.max(ref.maxSamples * 3, ref.maxSamples), 600);
}

function outPath(datasetId: string): string {
  if (LOCAL_ONLY_DATASET_IDS.has(datasetId)) {
    return join(REPO_ROOT, 'datasets', 'local', `${datasetId}.json`);
  }
  return join(REPO_ROOT, 'datasets', `${datasetId}.json`);
}

async function fetchOne(ref: DatasetRef): Promise<void> {
  const poolSize = poolSizeFor(ref);
  console.log(`Fetching ${ref.id} pool=${poolSize} maxSamples=${ref.maxSamples} seed=${ref.seed}…`);

  const { rows, usedDataset } = await fetchHfRows({
    dataset: ref.hf.dataset,
    fallbackDataset: ref.hf.fallbackDataset,
    config: ref.hf.config,
    split: ref.hf.split,
    limit: poolSize,
  });

  const normalized = rows.map((row, i) => ({
    id: `${ref.id}-${i}`,
    input: fieldToString(row[ref.fields.input]),
    gold: fieldToString(row[ref.fields.gold]),
    meta: row as Record<string, unknown>,
  }));

  const samples = seededSample(normalized, ref.maxSamples, ref.seed).map((s, i) => ({
    id: `${ref.id}-${i}`,
    input: s.input,
    gold: s.gold,
    // Drop bulky meta from committed files to keep size down
    meta: undefined as Record<string, unknown> | undefined,
  }));

  const bodyWithoutRevision: Omit<VendoredDatasetFile, 'revision'> & { revision?: string } = {
    id: ref.id,
    label: ref.label,
    task: ref.task,
    metric: ref.metric,
    source: `huggingface:${usedDataset}`,
    retrieved_at: new Date().toISOString(),
    license: LICENSES[ref.id] ?? 'UNKNOWN — verify before committing',
    seed: ref.seed,
    maxSamples: ref.maxSamples,
    hfDataset: usedDataset,
    hfConfig: ref.hf.config,
    hfSplit: ref.hf.split,
    samples,
  };

  // Pin revision to content hash of samples (stable offline identifier)
  const revision = createHash('sha256')
    .update(JSON.stringify({ id: ref.id, seed: ref.seed, samples: samples.map((s) => s.id) }))
    .digest('hex')
    .slice(0, 40);

  const file: VendoredDatasetFile = { ...bodyWithoutRevision, revision };

  const dest = outPath(ref.id);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${dest} (n=${samples.length}, revision=${revision})`);
}

async function main(): Promise<void> {
  const idArg = process.argv.find((a) => a.startsWith('--id='))?.slice('--id='.length);
  const targets = idArg
    ? [getDatasetById(idArg)].filter(Boolean)
    : EVAL_DATASETS.filter((d) => !LOCAL_ONLY_DATASET_IDS.has(d.id));

  if (idArg && targets.length === 0) {
    throw new Error(`Unknown dataset id: ${idArg}`);
  }

  for (const ref of targets as DatasetRef[]) {
    await fetchOne(ref);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
