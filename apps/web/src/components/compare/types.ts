/**
 * Compare is one flow with four stages. Preference and route optimization are
 * opt-in: a run that stops after `run` is still a valid ranking.
 */
export type CompareStage = 'setup' | 'run' | 'preference' | 'route';

export const STAGE_ORDER: CompareStage[] = ['setup', 'run', 'preference', 'route'];

export const STAGE_LABELS: Record<CompareStage, string> = {
  setup: 'Setup',
  run: 'Run',
  preference: 'Preference',
  route: 'Optimize route',
};

/** Text today, image now, audio later — every modality flows through Compare. */
export type Modality = 'text' | 'image';

export type TaskSource = 'dataset' | 'custom';

export interface DatasetInfo {
  id: string;
  label: string;
  task: string;
  metric: string;
  maxSamples: number;
}

/** An image prompt suite, the image modality's equivalent of a dataset. */
export interface SuiteInfo {
  id: string;
  label: string;
  description: string;
  promptCount: number;
}

export interface CompareSetup {
  modality: Modality;
  modelIds: string[];
  taskSource: TaskSource;
  datasetId: string;
  /** Image modality only: prompt suite to draw from. */
  suiteId: string;
  sampleCount: number;
  /** JSONL or JSON array of `{ id?, input, gold? }` */
  customPromptsRaw: string;
  promptSetLabel: string;
}

/** Modalities with no reference answer always resolve through preference. */
export const AUTO_SCORABLE: Record<Modality, boolean> = {
  text: true,
  image: false,
};

export interface EvalSampleResult {
  sampleId: string;
  score: number;
  latencyMs: number;
  prediction: string;
  error?: string;
}

export interface EvalTargetSummary {
  targetId: string;
  label: string;
  kind: 'model' | 'router';
  metric: string;
  n: number;
  quality: number;
  meanLatencyMs: number;
  sampleResults: EvalSampleResult[];
  caveat?: string;
  meanTtftMs?: number | null;
  tokensPerSec?: number | null;
  precision?: string | null;
  maxModelLen?: number | null;
}

export interface EvalRunMeta {
  runId: string;
  datasetId: string;
  datasetLabel: string;
  task: string;
  metric: string;
  sampleCount: number;
  seed: number;
  largeBaselineId: string | null;
  finishedAt: string;
  scored?: boolean;
  prompts?: Array<{ id: string; input: string }>;
}

export interface EvalRunResult {
  meta: EvalRunMeta;
  targets: EvalTargetSummary[];
}

export type EvalStreamEvent =
  | {
      type: 'start';
      runId: string;
      datasetId: string;
      sampleCount: number;
      targets: Array<{ targetId: string; label: string; kind: 'model' | 'router' }>;
      totalCalls: number;
      scored?: boolean;
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
    }
  | { type: 'target_done'; target: EvalTargetSummary }
  | { type: 'done'; result: EvalRunResult }
  | { type: 'cancelled'; message?: string }
  | { type: 'error'; message: string };

export type VoteWinner = 'a' | 'b' | 'tie';

export interface Competitor {
  modelId: string;
  label: string;
  answer: string;
  error?: string;
}

export interface Match {
  matchId: string;
  round: number;
  slot: number;
  a: string | null;
  b: string | null;
  winnerModelId: string | null;
  bye: boolean;
}

export interface Bracket {
  promptId: string;
  promptText: string;
  competitors: Competitor[];
  rounds: Match[][];
  championModelId: string | null;
}

export interface ModelStanding {
  modelId: string;
  label: string;
  championOf: number;
  wins: number;
  losses: number;
  ties: number;
  winRate: number;
}

export interface TournamentAggregate {
  overallChampionModelId: string | null;
  standings: ModelStanding[];
  winnerByPrompt: Record<string, string | null>;
  winMatrix: Record<string, Record<string, number>>;
  matchesTotal: number;
  matchesVoted: number;
}

export interface TournamentMeta {
  runId: string;
  sourceRunId: string;
  modality: Modality;
  modelIds: string[];
  promptIds: string[];
  createdAt: string;
  finishedAt: string | null;
}

export interface TournamentState {
  meta: TournamentMeta;
  brackets: Bracket[];
  aggregate: TournamentAggregate;
}

export interface RoutePolicySummary {
  meta: {
    runId: string;
    sampleCount: number;
    smallModelLabel: string;
    largeModelLabel: string;
    labelSmall: number;
    labelLarge: number;
  };
  saveRate: number;
  oracleQuality: number;
  oracleRelativeCostPct: number;
  heuristicAgreeWithOracle: number;
  smallAloneQuality: number;
  largeAloneQuality: number;
}

export interface RoutePolicyResult {
  saved: boolean;
  routingRunId: string;
  summary: RoutePolicySummary;
  skipped: number;
  examples: Array<{
    sampleId: string;
    input: string;
    label: 'small' | 'large';
    labelReason: string;
  }>;
}

export interface ParsedPrompt {
  id?: string;
  input: string;
  gold?: string;
}

/**
 * Accept a JSON array or JSONL. Bare lines are treated as the prompt itself so
 * pasting a plain list of questions just works.
 */
export function parsePrompts(raw: string): { prompts: ParsedPrompt[]; error: string | null } {
  const text = raw.trim();
  if (!text) return { prompts: [], error: null };

  const fromRow = (row: unknown, index: number): ParsedPrompt | null => {
    if (typeof row === 'string') {
      return row.trim() ? { id: `p${index + 1}`, input: row.trim() } : null;
    }
    if (row && typeof row === 'object') {
      const r = row as Record<string, unknown>;
      const input = typeof r.input === 'string' ? r.input : null;
      if (!input?.trim()) return null;
      return {
        id: typeof r.id === 'string' && r.id.trim() ? r.id.trim() : `p${index + 1}`,
        input: input.trim(),
        gold: typeof r.gold === 'string' && r.gold.trim() ? r.gold.trim() : undefined,
      };
    }
    return null;
  };

  if (text.startsWith('[')) {
    try {
      const arr = JSON.parse(text) as unknown[];
      if (!Array.isArray(arr)) return { prompts: [], error: 'Expected a JSON array' };
      const prompts = arr.map(fromRow).filter((p): p is ParsedPrompt => p != null);
      return { prompts, error: prompts.length ? null : 'No usable prompts in the array' };
    } catch (e) {
      return { prompts: [], error: e instanceof Error ? e.message : 'Invalid JSON' };
    }
  }

  const prompts: ParsedPrompt[] = [];
  const lines = text.split('\n').filter((l) => l.trim());
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (line.startsWith('{')) {
      try {
        const parsed = fromRow(JSON.parse(line), i);
        if (parsed) prompts.push(parsed);
      } catch {
        return { prompts: [], error: `Line ${i + 1} is not valid JSON` };
      }
    } else {
      const parsed = fromRow(line, i);
      if (parsed) prompts.push(parsed);
    }
  }
  return { prompts, error: prompts.length ? null : 'No usable prompts' };
}