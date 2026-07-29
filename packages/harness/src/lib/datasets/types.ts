import type { DatasetTask, MetricId } from '../../config/datasets';

/** Normalized eval sample used by loaders + later eval runners. */
export interface EvalSample {
  id: string;
  input: string;
  gold: string;
  /** Raw HF row for debugging / future prompt templates */
  meta?: Record<string, unknown>;
}

export interface LoadedDataset {
  datasetId: string;
  label: string;
  task: DatasetTask;
  metric: MetricId;
  hfDataset: string;
  hfConfig: string;
  hfSplit: string;
  seed: number;
  maxSamples: number;
  /** True when served from vendored / local disk */
  fromCache: boolean;
  samples: EvalSample[];
  /** Vendored file revision string (HF commit / content pin) */
  revision?: string;
  /** sha256 of the vendored JSON file */
  revisionHash?: string;
  retrievedAt?: string;
  license?: string;
  vendoredPath?: string;
}
