import type { EvalSample } from '../datasets/types';
import type { ScriptPolicy, ScriptPolicyBundle } from '../script-policy';
import { defaultScriptBundle } from '../script-policy';

/** Demo gene — selection + ordering + count evolved by GEPA. */
export interface Demo {
  input: string;
  output: string;
}

/** Model reference gene (routing absorbed here). */
export interface ModelGene {
  modelId: string;
  providerId?: string;
  /** Catalog id when resolved via resolveEvalModel */
  catalogId?: string;
  relativeCostWeight?: number;
}

/**
 * Program candidate. Phase 3 evolves instruction + demos + model + script_policy.
 */
export interface Candidate {
  id: string;
  instruction: string;
  demos: Demo[];
  model: ModelGene;
  /** @deprecated Prefer scriptPolicies; kept for older runs */
  scriptPolicy?: ScriptPolicy;
  /** Independent policies for instruction / demos / input */
  scriptPolicies?: ScriptPolicyBundle;
  maxPromptTokens?: number | null;
  /** How many demos the genome requests before context fitting */
  demosRequested?: number;
  /** Ancestor candidate ids (lineage for merge) */
  parentIds: string[];
  /** Accumulated Actionable Side Information lessons from ancestors */
  lessons: string[];
}

export type Example = EvalSample & {
  split?: 'train' | 'val' | 'test';
};

export interface MetricOutcome {
  score: number;
  feedback: string;
}

export interface FertilitySummary {
  languageHint: string;
  tokens: number;
  words: number;
  fertility: number;
  measured: boolean;
}

export interface EvalBatch {
  /** Mean quality in [0, 1] */
  quality: number;
  /** Relative cost weight (never absolute currency) */
  meanRelativeCost: number;
  promptTokens: number;
  completionTokens: number;
  /** Total tokens = prompt + completion */
  totalTokens: number;
  latencyP50: number;
  latencyP95?: number;
  /** Whether prompt/completion tokens came from the model tokenizer / provider */
  tokensMeasured?: boolean;
  demosRequested?: number;
  demosFitted?: number;
  /** Tokens/word by language hint (measured when possible) */
  fertilityByLanguage?: Record<string, FertilitySummary>;
  /** Per-example outcomes */
  outcomes: Array<{
    exampleId: string;
    score: number;
    feedback: string;
    latencyMs?: number;
    promptTokens?: number;
    completionTokens?: number;
    prediction?: string;
    prompt?: string;
    demosFitted?: number;
  }>;
  /** Free-form traces for reflection */
  traces?: string[];
}

export interface FrontierPoint {
  candidateId: string;
  quality: number;
  totalTokens: number;
  meanRelativeCost: number;
  feasible: boolean;
}

export interface OptimizeContext {
  seed: number;
  maxRollouts: number;
  qualityFloor: number;
  minibatchSize: number;
  /** Run system-aware merge every N accepted mutations (0 = disable) */
  mergeEvery: number;
  /** Catalog/model id for the reflection LLM */
  reflectModelId: string;
  reflectProviderId?: string;
  /** Seed / discrete search space (at least the unoptimized program) */
  candidates: Candidate[];
  demoPool: Demo[];
  modelCatalog: ModelGene[];
  split: { train: Example[]; val: Example[]; test: Example[] };
  /**
   * Splits the optimizer may touch. Must not include `test` if test will be reported.
   * Framework refuses reporting test metrics optimized against (assertSplitIsolation).
   */
  optimizedAgainst: Array<'train' | 'val' | 'test'>;
  evaluate: (candidate: Candidate, examples: Example[]) => Promise<EvalBatch>;
  /** Fixed user goal + rubric for custom / llm_judge runs */
  customGoal?: { goal: string; rubric: string };
  /**
   * Reflective mutation: LLM proposes an improved candidate from ASI.
   * Injected so tests can stub without provider calls.
   */
  reflect?: (args: {
    parent: Candidate;
    reflectiveDataset: ReflectiveRecord[];
    lessons: string[];
  }) => Promise<Candidate>;
  signal?: AbortSignal;
}

/** One row of the reflective dataset (Actionable Side Information). */
export interface ReflectiveRecord {
  exampleId: string;
  input: string;
  gold: string;
  prediction: string;
  score: number;
  feedback: string;
  trace: string;
}

export type OptimizeEvent =
  | {
      type: 'start';
      candidateCount: number;
      maxRollouts: number;
      qualityFloor: number;
      runId?: string;
    }
  | {
      type: 'rollout';
      index: number;
      candidate: Candidate;
      train: EvalBatch;
      val: EvalBatch;
      feasible: boolean;
    }
  | {
      type: 'frontier';
      points: FrontierPoint[];
      coverage: Record<string, number>;
    }
  | {
      type: 'reflect';
      parentId: string;
      childId: string;
      lesson: string;
    }
  | {
      type: 'merge';
      parentA: string;
      parentB: string;
      childId: string;
    }
  | {
      type: 'infeasible';
      candidateId: string;
      quality: number;
      qualityFloor: number;
    }
  | {
      type: 'done';
      best: Candidate | null;
      bestVal: EvalBatch | null;
      test: EvalBatch | null;
      baseline: Candidate | null;
      baselineVal: EvalBatch | null;
      rollouts: number;
      frontier: FrontierPoint[];
    }
  | { type: 'cancelled'; message?: string }
  | { type: 'error'; message: string };

export interface Optimizer {
  optimize(ctx: OptimizeContext): AsyncGenerator<OptimizeEvent>;
}

export function newCandidateId(prefix = 'c'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function resolveScriptPolicies(c: Candidate): ScriptPolicyBundle {
  if (c.scriptPolicies) return c.scriptPolicies;
  return defaultScriptBundle(c.scriptPolicy ?? 'passthrough');
}

export function seedCandidate(partial: {
  instruction: string;
  demos?: Demo[];
  model: ModelGene;
  scriptPolicies?: ScriptPolicyBundle;
  maxPromptTokens?: number | null;
  demosRequested?: number;
}): Candidate {
  const demos = partial.demos ?? [];
  return {
    id: newCandidateId('seed'),
    instruction: partial.instruction,
    demos,
    model: partial.model,
    scriptPolicy: partial.scriptPolicies?.instruction ?? 'passthrough',
    scriptPolicies: partial.scriptPolicies ?? defaultScriptBundle('passthrough'),
    maxPromptTokens: partial.maxPromptTokens ?? null,
    demosRequested: partial.demosRequested ?? demos.length,
    parentIds: [],
    lessons: [],
  };
}
