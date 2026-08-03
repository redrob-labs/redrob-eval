/**
 * Task-grounded preference generation types (Stage 1).
 * Cost, when reported, is relative % of a baseline — never absolute currency.
 */

import type { CustomGoalSpec } from '../optimizer/custom-goal';

export type PreferenceRunStatus = 'queued' | 'running' | 'ready' | 'failed' | 'stopped';

export type PreferenceGenerationParams = {
  temperature: number;
  maxTokens: number;
  seed?: number;
  /** 1 = single call; N = fan-out over Example.meta.sections */
  parallelSections: number;
};

export type PreferenceRun = {
  id: string;
  taskId: string;
  /** Full Custom Goal snapshot — source of truth for this run */
  task: CustomGoalSpec;
  modelIds: string[];
  inputIds: string[];
  generationParams: PreferenceGenerationParams;
  /** Fingerprint of system+user template — identical for every model */
  promptFingerprint: string;
  createdAt: string;
  status: PreferenceRunStatus;
  finishedAt?: string;
  error?: string;
  /** Catalog id used as 100% relative-cost baseline when summarizing */
  baselineModelId?: string;
};

export type GenerationUsage = {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  /** Visible completion tokens only — never includes reasoningTokens */
  outputTokens: number;
  /** Billed as output but not in the response body; kept separate */
  reasoningTokens?: number;
};

export type GenerationLatency = {
  timeToFirstTokenMs: number | null;
  totalMs: number;
};

export type SectionGeneration = {
  sectionIndex: number;
  output: string;
  usage: GenerationUsage;
  /** Verbatim provider finish/stop reason; '' if omitted */
  finishReason: string;
  latency: GenerationLatency;
  error?: string;
};

export type Generation = {
  runId: string;
  modelId: string;
  inputId: string;
  output: string;
  usage: GenerationUsage;
  finishReason: string;
  latency: GenerationLatency;
  sections?: SectionGeneration[];
  error?: string;
};

export type CellStatus = 'ok' | 'error' | 'truncated' | 'pending';

export type CompletionMatrix = {
  modelIds: string[];
  inputIds: string[];
  cells: Record<string, Record<string, CellStatus>>;
  completed: number;
  total: number;
};

export type SectionLengthDistribution = {
  n: number;
  meanChars: number;
  p50Chars: number;
  p90Chars: number;
  /** Fraction of sections with outputTokens within ε of maxTokens — cap signature */
  fractionNearMaxTokens: number;
};

export type ModelRunStats = {
  modelId: string;
  ok: number;
  errors: number;
  truncationRate: number;
  meanOutputTokens: number;
  meanReasoningTokens: number;
  sectionLengthDistribution?: SectionLengthDistribution;
};

export type PreferenceRunSummary = {
  runId: string;
  completion: CompletionMatrix;
  byModel: ModelRunStats[];
  truncationWarning: boolean;
  truncationWarningMessage?: string;
  /** Relative cost % of baseline (never currency) */
  relativeCostPctByModel?: Record<string, number>;
};

export type PreferenceProgressEvent =
  | { type: 'start'; runId: string; total: number }
  | {
      type: 'cell';
      runId: string;
      modelId: string;
      inputId: string;
      status: CellStatus;
      done: number;
      total: number;
    }
  | { type: 'done'; runId: string; summary: PreferenceRunSummary }
  | { type: 'error'; runId: string; message: string }
  | { type: 'cancelled'; runId: string; message?: string };
