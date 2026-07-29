/**
 * Reproducibility stamp for a run. Missing fields must be explicit null — never omitted.
 */
export interface RunManifest {
  seed: number | null;
  temperature: number | null;
  providerName: string | null;
  modelVersion: string | null;
  tokenizerVersion: string | null;
  datasetId: string | null;
  datasetRevision: string | null;
  harnessGitSha: string | null;
  startedAtUtc: string | null;
  finishedAtUtc: string | null;
  maxRollouts: number | null;
  smallModelId: string | null;
  largeModelId: string | null;
}
