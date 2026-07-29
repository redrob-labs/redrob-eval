/**
 * Vendored eval subset schema.
 * Every committed dataset JSON must include source, revision, retrieved_at.
 */
export interface VendoredDatasetFile {
  id: string;
  label: string;
  task: string;
  metric: string;
  source: string;
  revision: string;
  retrieved_at: string;
  license: string;
  seed: number;
  maxSamples: number;
  hfDataset: string;
  hfConfig: string;
  hfSplit: string;
  samples: Array<{
    id: string;
    input: string;
    gold: string;
    meta?: Record<string, unknown>;
  }>;
}
