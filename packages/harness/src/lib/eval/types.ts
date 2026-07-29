import type { MetricId, DatasetTask } from '../../config/datasets';
import type { RouteDecision } from '../router/index';

export const ROUTER_TARGET_ID = 'router';

export interface EvalSampleResult {
  sampleId: string;
  score: number;
  latencyMs: number;
  prediction: string;
  error?: string;
  route?: RouteDecision;
}

export interface EvalTargetSummary {
  /** Catalog model id, or "router" */
  targetId: string;
  label: string;
  kind: 'model' | 'router';
  metric: MetricId;
  n: number;
  /** Mean quality in [0, 1] */
  quality: number;
  /** Mean latency ms over successful calls */
  meanLatencyMs: number;
  /**
   * Mean relative cost weight across samples.
   * For a single model = that model's weight.
   * For router = average of chosen models' weights.
   */
  meanRelativeCost: number;
  /** Relative cost as % of the large baseline (large = 100) */
  relativeCostPct: number;
  sampleResults: EvalSampleResult[];
  /** Router-only: fraction of decisions that followed easy→small / hard→large */
  routingPolicyAccuracy?: number;
  /** Router-only vs small-model oracle when small results available */
  routingOracleAccuracy?: number | null;
  /** quality / largeBaselineQuality when available */
  qualityRetention?: number | null;
}

export interface EvalRunMeta {
  runId: string;
  datasetId: string;
  datasetLabel: string;
  task: DatasetTask;
  metric: MetricId;
  sampleCount: number;
  seed: number;
  largeBaselineId: string | null;
  finishedAt: string;
}

export interface EvalRunResult {
  meta: EvalRunMeta;
  targets: EvalTargetSummary[];
  routingLog: RouteDecision[];
}

export type EvalStreamEvent =
  | {
      type: 'start';
      runId: string;
      datasetId: string;
      sampleCount: number;
      targets: Array<{ targetId: string; label: string; kind: 'model' | 'router' }>;
      totalCalls: number;
    }
  | {
      type: 'progress';
      done: number;
      total: number;
      targetId: string;
      sampleIndex: number;
      sampleId: string;
      score?: number;
      latencyMs?: number;
      error?: string;
      route?: RouteDecision;
    }
  | { type: 'target_done'; target: EvalTargetSummary }
  | { type: 'done'; result: EvalRunResult }
  | { type: 'cancelled'; message?: string }
  | { type: 'error'; message: string };
