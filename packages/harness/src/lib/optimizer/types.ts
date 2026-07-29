import type { EvalSample } from '../datasets/types';
import type { FramePolicy } from '../frame-policy';
import { defaultFramePolicy } from '../frame-policy';
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
 * Program candidate. Evolves instruction + demos + model + script_policy + frame_policy.
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
  /** Frame sampling gene for checklist / video scoring */
  framePolicy?: FramePolicy;
  maxPromptTokens?: number | null;
  /** How many demos the genome requests before context fitting */
  demosRequested?: number;
  /** How many frames the genome requests before visual-token fitting */
  framesRequested?: number;
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
  framesRequested?: number;
  framesFitted?: number;
  /** Fraction of clips the model declined to score (not folded into QWK) */
  abstentionRate?: number;
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
    framesFitted?: number;
    abstained?: boolean;
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
   * Fixed few-shot frame-set anchors for checklist scoring (not rewritten by GEPA).
   */
  referenceAnchors?: Array<{ label: string; framePaths: string[] }>;
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

export function resolveFramePolicy(c: Candidate): FramePolicy {
  return defaultFramePolicy(c.framePolicy);
}

export function seedCandidate(partial: {
  instruction: string;
  demos?: Demo[];
  model: ModelGene;
  scriptPolicies?: ScriptPolicyBundle;
  framePolicy?: FramePolicy;
  maxPromptTokens?: number | null;
  demosRequested?: number;
  framesRequested?: number;
}): Candidate {
  const demos = partial.demos ?? [];
  const framePolicy = partial.framePolicy
    ? defaultFramePolicy(partial.framePolicy)
    : undefined;
  return {
    id: newCandidateId('seed'),
    instruction: partial.instruction,
    demos,
    model: partial.model,
    scriptPolicy: partial.scriptPolicies?.instruction ?? 'passthrough',
    scriptPolicies: partial.scriptPolicies ?? defaultScriptBundle('passthrough'),
    framePolicy,
    maxPromptTokens: partial.maxPromptTokens ?? null,
    demosRequested: partial.demosRequested ?? demos.length,
    framesRequested: partial.framesRequested ?? framePolicy?.n_frames,
    parentIds: [],
    lessons: [],
  };
}
