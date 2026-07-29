import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import type { EvalStreamEvent } from '../eval/types';
import type { LoadedDataset } from '../datasets/types';
import type { ModelRef } from '../../config/models';
import {
  appendProgressEvent,
  writeRunManifest,
} from './fs';
import type { RunManifest } from './manifest';
import { getRepoRoot } from '../paths';

export function tryGitSha(): string | null {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: getRepoRoot(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export function buildRunManifest(params: {
  seed: number | null;
  temperature: number | null;
  small: ModelRef | null;
  large: ModelRef | null;
  dataset: LoadedDataset | null;
  maxRollouts?: number | null;
  startedAtUtc: string | null;
  finishedAtUtc?: string | null;
}): RunManifest {
  return {
    seed: params.seed,
    temperature: params.temperature,
    providerName: params.small?.providerId ?? null,
    modelVersion: params.small
      ? `${params.small.providerId}:${params.small.modelId}`
      : null,
    tokenizerVersion: null,
    datasetId: params.dataset?.datasetId ?? null,
    datasetRevision: params.dataset?.revisionHash ?? params.dataset?.revision ?? null,
    harnessGitSha: tryGitSha(),
    startedAtUtc: params.startedAtUtc,
    finishedAtUtc: params.finishedAtUtc ?? null,
    maxRollouts: params.maxRollouts ?? null,
    smallModelId: params.small?.id ?? null,
    largeModelId: params.large?.id ?? null,
  };
}

/** Persist an event and return it (for generator wrapping). */
export async function persistAndYield(
  runId: string,
  event: EvalStreamEvent,
): Promise<EvalStreamEvent> {
  await appendProgressEvent(runId, event);
  return event;
}

export function candidateHash(parts: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
}
