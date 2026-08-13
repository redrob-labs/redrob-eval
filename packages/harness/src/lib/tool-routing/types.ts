/**
 * Fixed-toolset routing harness types.
 *
 * Languages are constraints recorded on every slice, not optimization targets.
 * Compare runs the production JSON contract only. The bare condition remains
 * readable for old reports and offline prompt experiments.
 */

export type ToolRoutingLanguage = 'en' | 'hi' | 'hi-Latn' | 'ko';

export type ToolRoutingCondition = 'bare' | 'contract';

export const TOOL_ROUTING_LANGUAGES: ToolRoutingLanguage[] = [
  'en',
  'hi',
  'hi-Latn',
  'ko',
];

/** Initial Compare selection. Users may remove languages for a smaller run. */
export const TOOL_ROUTING_DEFAULT_LANGUAGES: ToolRoutingLanguage[] = [
  ...TOOL_ROUTING_LANGUAGES,
];

/** Validate an API/UI language selection against the fixture languages. */
export function normalizeToolRoutingLanguages(input: unknown): ToolRoutingLanguage[] {
  if (input == null) return [...TOOL_ROUTING_DEFAULT_LANGUAGES];
  if (!Array.isArray(input)) {
    throw new Error('languages must be an array');
  }
  const allowed = new Set<ToolRoutingLanguage>(TOOL_ROUTING_LANGUAGES);
  const languages = [
    ...new Set(
      input.filter(
        (value): value is ToolRoutingLanguage =>
          typeof value === 'string' && allowed.has(value as ToolRoutingLanguage),
      ),
    ),
  ];
  if (languages.length === 0) {
    throw new Error('Select at least one tool-routing language');
  }
  return languages;
}

export const TOOL_ROUTING_CONDITIONS: ToolRoutingCondition[] = ['bare', 'contract'];
export const TOOL_ROUTING_COMPARE_CONDITIONS: ToolRoutingCondition[] = ['contract'];

/**
 * How many tools the task offers.
 *
 * `core` is the six-tool set every scenario has always used. `wide` adds near
 * neighbours of the right answer, which is where routers actually break: with
 * six tools a model can be right by elimination, and that flatters it.
 */
export type ToolsetId = 'core' | 'wide' | 'full';

export const TOOLSETS: ToolsetId[] = ['core', 'wide', 'full'];

/** Forced absence outcomes the router must emit when it cannot act. */
export type AbsenceAction = 'BLOCK' | 'DEFER';

export type ExpectedOutcome =
  | { kind: 'call'; tool: string; arguments: Record<string, unknown> }
  | { kind: 'absence'; action: AbsenceAction };

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * One routing example. Fixture interface only - full set generation is out of scope.
 */
export interface ToolRoutingTask {
  id: string;
  language: ToolRoutingLanguage;
  user: string;
  toolset: ToolsetId;
  tools: ToolDefinition[];
  expected: ExpectedOutcome;
}

export type ParsedPrediction =
  | { kind: 'call'; tool: string; arguments: Record<string, unknown>; raw: string }
  | { kind: 'absence'; action: AbsenceAction; raw: string }
  | {
      kind: 'parse_error';
      raw: string;
      message: string;
      /**
       * The call the model meant, when the only thing wrong was the wrapper.
       *
       * Midm names the tool in `action`, the key the contract reserves for
       * BLOCK and DEFER, and gets the tool and the arguments right underneath.
       * That still fails the contract, so it is still a parse error - but a
       * report that cannot tell it apart from unparseable output invites the
       * wrong conclusion about whether the model can route at all.
       */
      envelope?: { tool: string; arguments: Record<string, unknown> };
    };

export interface ToolRoutingExampleScore {
  toolSelectCorrect: boolean | null;
  argExactMatch: boolean | null;
  absenceCorrect: boolean | null;
  parseFailed: boolean;
  /** Parse failed on the wrapper alone. Optional: absent on reports predating it. */
  envelopeError?: boolean;
  /** Whether that wrapped call named the expected tool. Null when not applicable. */
  envelopeToolWouldMatch?: boolean | null;
  /** GPU wall time for this call; always measured when a call ran. */
  latencyGpuMs: number | null;
  /** Reserved; this harness does not measure CPU serving. Always null. */
  latencyCpuMs: null;
}

/**
 * One model's reply to one task under one condition.
 *
 * The slices only carry rates, and a rate cannot be argued with. Keeping the
 * reply itself is what lets a person read the run afterwards, and it is what a
 * blind preference vote puts on screen.
 */
export interface ToolRoutingExampleRecord {
  taskId: string;
  language: ToolRoutingLanguage;
  condition: ToolRoutingCondition;
  /** Which toolset the task offered, so wide can be read against core. */
  toolset: ToolsetId;
  /** Exactly what came back, before parsing. Empty when the call itself failed. */
  raw: string;
  /** Exact prompt sent to the model. Optional on legacy reports. */
  prompt?: string;
  /**
   * What the task wanted. Kept alongside the reply so a failure can be read
   * without the fixtures to hand: "wrong arguments" is not a finding until you
   * can see which ones were wanted. Optional on reports written before this.
   */
  expected?: ExpectedOutcome;
  parsed: ParsedPrediction;
  score: ToolRoutingExampleScore;
  /** Set when the provider call threw, as opposed to answering something unusable. */
  error?: string;
}

export interface ToolRoutingConditionSlice {
  condition: ToolRoutingCondition;
  language: ToolRoutingLanguage;
  n: number;
  toolSelectAccuracy: number | null;
  argExactMatchAccuracy: number | null;
  absenceAccuracy: number | null;
  parseFailureRate: number;
  /**
   * How many examples each accuracy was taken over. Each metric skips the
   * examples it does not apply to, so a reader combining slices needs these to
   * weight them: averaging the rates would silently assume equal denominators.
   */
  denominators: {
    toolSelect: number;
    argExactMatch: number;
    absence: number;
  };
  /**
   * The share of the parse failures that were only the wrapper. Scoring stays
   * strict - these are counted in `parseFailureRate` too - but a model that
   * routed correctly into the wrong key reads very differently from one that
   * returned prose, and the rate alone cannot say which happened. Optional:
   * reports written before this existed do not carry it.
   */
  envelope?: {
    errors: number;
    /** Of those, how many named the expected tool anyway. */
    toolWouldMatch: number;
  };
  latencyGpuMs: { p50: number | null; p95: number | null };
  latencyCpuMs: { p50: null; p95: null };
}

export interface ToolRoutingConditionDelta {
  language: ToolRoutingLanguage;
  /** contract − bare */
  contractMinusBare: {
    toolSelectAccuracy: number | null;
    argExactMatchAccuracy: number | null;
    absenceAccuracy: number | null;
    parseFailureRate: number | null;
  };
}

export interface FertilityCell {
  modelId: string;
  hfRepoId: string;
  language: ToolRoutingLanguage;
  tokens: number;
  words: number;
  fertility: number;
  /** Relative to Qwen3-0.6B on the same language (baseline = 1.0). */
  relativeToBaseline: number | null;
  tokenizerId: string;
  /**
   * False means the real tokenizer never loaded. tokens/words/fertility are
   * zero in that case: this harness reports no number rather than an estimate.
   */
  measured: boolean;
  error?: string;
}

export interface ToolRoutingReport {
  /**
   * v2 dropped the grammar condition and the EBNF disclaimer that went with it.
   * Guided decoding only exists on vLLM, so grammar could never be measured on
   * a hosted model, and a column that half the field cannot enter is not a
   * comparison.
   */
  schema: 'redrob-tool-routing/v2';
  createdAt: string;
  modelId: string;
  /** Null for hosted APIs, where no weights are named and none can be checked. */
  hfRepoId: string | null;
  /** Languages appear as constraints, never as optimization objectives. */
  languageConstraints: ToolRoutingLanguage[];
  conditions: ToolRoutingCondition[];
  slices: ToolRoutingConditionSlice[];
  deltas: ToolRoutingConditionDelta[];
  /** Every reply, in task order. Absent on reports built from slices alone. */
  examples?: ToolRoutingExampleRecord[];
  fertility?: FertilityCell[];
  skipped?: { reason: string }[];
}
