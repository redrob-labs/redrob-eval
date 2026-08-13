/** Shapes the Analyze API routes return. Kept local so the client is self-contained. */

export interface RunRow {
  id: string;
  kind: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  label?: string;
  tags: string[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  provenance: {
    gitSha: string | null;
    gitDirty: boolean;
    paramsHash: string;
    models: string[];
    datasetId?: string;
    runtime: { node: string; platform: string };
  };
  params: unknown;
  summary?: unknown;
  error?: string;
}

export interface RunEvent {
  seq: number;
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  data?: unknown;
}

export interface RunsResponse {
  runs: RunRow[];
  total: number;
  kinds: string[];
  driver: string;
}

export interface RunDetailResponse {
  run: RunRow;
  events: RunEvent[];
  artifacts: string[];
}

export interface Failure {
  id: string;
  kind: string;
  detail: string;
  source: string;
  model: string;
  item: string;
  language?: string;
  turn?: number;
  capability?: string;
  expected?: string;
  actual?: string;
  prompt?: string;
  annotated?: boolean;
  derivedKind?: string;
  note?: string;
}

export interface FailuresResponse {
  failures: Failure[];
  tally: Array<{ kind: string; count: number; share: number }>;
  artifactCount: number;
  facets: { kinds: string[]; models: string[]; languages: string[] };
}

export interface Interval {
  low: number;
  high: number;
}

export interface CompareResponse {
  metric: string;
  availableMetrics?: string[];
  rates: Array<{ model: string; rate: number; successes: number; n: number; interval: Interval }>;
  pairs: Array<{
    a: { model: string };
    b: { model: string };
    sharedItems: number;
    mcnemar: { aOnly: number; bOnly: number; agreed: number; p: number };
    diff: { value: number; interval: Interval };
    adjustedP: number;
    warnings: string[];
  }>;
  error?: string;
}

/** Failures a prompt or parser change could plausibly clear. */
export const RECOVERABLE = new Set(['format', 'envelope', 'desynced']);

export const COMPARE_METRICS = ['toolSelect', 'argExact', 'absence', 'parsed'] as const;
