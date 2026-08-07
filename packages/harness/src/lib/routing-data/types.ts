import type { DatasetTask, MetricId } from '../../config/datasets';
import type { RouteDecision } from '../router/index';

/** Optimal tier for this sample given small/large outcomes. */
export type RouteLabel = 'small' | 'large';

export type RouterPolicyId = 'heuristic' | 'oracle' | 'cascade';

export interface ModelCallRecord {
  modelId: string;
  modelLabel: string;
  relativeCostWeight: number;
  prediction: string;
  score: number;
  /** Why the score is what it is (metric feedback text) */
  feedback?: string;
  latencyMs: number;
  /** Self-hosted: time to first token when streaming */
  timeToFirstTokenMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
}

/** Features extracted for routing-SLM training (no gold leakage). */
export interface RoutingFeatures {
  charLen: number;
  wordCount: number;
  digitCount: number;
  sentenceCount: number;
  questionMarkCount: number;
  newlineCount: number;
  avgWordLen: number;
  heuristicScore: number;
  heuristicComplexity: 'easy' | 'hard';
  heuristicReasons: string[];
  task: DatasetTask;
  datasetId: string;
}

/**
 * One dual-eval example — the atomic unit of the routing corpus.
 * Small and large are always both attempted so labels are outcome-supervised.
 */
export interface RoutingExample {
  id: string;
  runId: string;
  createdAt: string;
  sampleId: string;
  datasetId: string;
  datasetLabel: string;
  task: DatasetTask;
  metric: MetricId;
  seed: number;
  input: string;
  gold: string;
  small: ModelCallRecord;
  large: ModelCallRecord;
  /** Outcome-supervised label for SLM training */
  label: RouteLabel;
  labelReason: string;
  /** Configurable threshold used when labeling */
  smallOkThreshold: number;
  features: RoutingFeatures;
  heuristic: RouteDecision;
}

export interface RoutingRunMeta {
  runId: string;
  createdAt: string;
  finishedAt?: string;
  status: 'queued' | 'running' | 'ready' | 'failed' | 'stopped';
  datasetId: string;
  datasetLabel: string;
  task: DatasetTask;
  metric: MetricId;
  sampleCount: number;
  seed: number;
  smallModelId: string;
  largeModelId: string;
  smallModelLabel: string;
  largeModelLabel: string;
  smallOkThreshold: number;
  labeled: number;
  labelSmall: number;
  labelLarge: number;
  error?: string;
}

export interface RoutingRunSummary {
  meta: RoutingRunMeta;
  /** Fraction labeled small (potential cost save) */
  saveRate: number;
  /** Mean quality if always following oracle labels */
  oracleQuality: number;
  /** Mean relative cost % if following oracle (large baseline = 100) */
  oracleRelativeCostPct: number;
  heuristicAgreeWithOracle: number;
  smallAloneQuality: number;
  largeAloneQuality: number;
}

export interface CorpusStats {
  exampleCount: number;
  runCount: number;
  byDataset: Record<string, number>;
  byTask: Record<string, number>;
  byLabel: Record<RouteLabel, number>;
  lastUpdatedAt: string | null;
}

/** Prompt-style row for chat-tuned routing SLMs */
export interface RoutingTrainChatRow {
  id: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  meta: {
    datasetId: string;
    task: DatasetTask;
    label: RouteLabel;
    runId: string;
    sampleId: string;
  };
}

/** Tabular / classifier-friendly export row */
export interface RoutingTrainFlatRow {
  id: string;
  input: string;
  label: RouteLabel;
  task: DatasetTask;
  datasetId: string;
  features: RoutingFeatures;
  runId: string;
  sampleId: string;
  smallScore: number;
  largeScore: number;
  smallModelId: string;
  largeModelId: string;
}
