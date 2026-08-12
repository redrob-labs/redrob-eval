/** Shared shapes for the Compare tool-routing modality (mirrors the harness report schema). */

/**
 * What Deploy tells vLLM to call the model it serves. Duplicated from the
 * harness catalog rather than imported, so the browser bundle does not pull the
 * server-side config in for one string.
 */
export const SERVED_MODEL_NAME = 'redrob';

/** The endpoint Deploy manages, as opposed to a host the user registered. */
export const BUILTIN_HOST_ID = 'builtin';

export type FertilityCell = {
  modelId: string;
  hfRepoId: string;
  language: string;
  tokens: number;
  words: number;
  fertility: number;
  relativeToBaseline: number | null;
  tokenizerId: string;
  /** False means the tokenizer never loaded, so there is no number to show. */
  measured: boolean;
  error?: string;
};

/** One /v1/models row: the alias, and the weights hiding behind it. */
export type VllmServedModel = {
  id: string;
  /** vLLM `root`, the launch argument. Null when the endpoint omits it. */
  root: string | null;
  maxModelLen: number | null;
};

/** Result of probing the vLLM endpoint, not just checking that a key is set. */
export type VllmHealth = {
  hostId: string;
  hostLabel: string;
  configured: boolean;
  reachable: boolean;
  baseUrl: string;
  status: number | null;
  error: string | null;
  servedModels: string[];
  served: VllmServedModel[];
  servedModelFound: boolean | null;
  servedModel: VllmServedModel | null;
};

/** A registered endpoint. Key material never reaches the browser. */
export type VllmHost = {
  id: string;
  label: string;
  baseUrl: string;
  source: 'builtin' | 'custom';
  editable: boolean;
  envKey: string | null;
  hasOwnKey: boolean;
  keyHint: string | null;
};

export type ConditionSlice = {
  condition: string;
  language: string;
  n: number;
  toolSelectAccuracy: number | null;
  argExactMatchAccuracy: number | null;
  absenceAccuracy: number | null;
  parseFailureRate: number;
  denominators: { toolSelect: number; argExactMatch: number; absence: number };
  /**
   * Parse failures that were only the wrapper: the tool name landed in
   * `action`, the key reserved for BLOCK and DEFER. Absent on reports saved
   * before the split existed.
   */
  envelope?: { errors: number; toolWouldMatch: number };
  latencyGpuMs: { p50: number | null; p95: number | null };
  latencyCpuMs: { p50: null; p95: null };
};

/**
 * Collapse a condition's per-language slices into one row. Weighted by each
 * metric's own denominator, because a plain mean of the rates would treat a
 * language with two scored examples as equal to one with eight.
 */
export function rollUpCondition(
  slices: ConditionSlice[],
  condition: string,
): ConditionSlice | null {
  const rows = slices.filter((s) => s.condition === condition);
  if (rows.length === 0) return null;

  const weighted = (
    pick: (s: ConditionSlice) => number | null,
    denom: (s: ConditionSlice) => number,
  ): number | null => {
    let hits = 0;
    let total = 0;
    for (const s of rows) {
      const value = pick(s);
      const d = denom(s);
      if (value == null || d === 0) continue;
      hits += value * d;
      total += d;
    }
    return total === 0 ? null : hits / total;
  };

  const n = rows.reduce((sum, s) => sum + s.n, 0);
  const gpuP50 = rows.map((s) => s.latencyGpuMs.p50).filter((v): v is number => v != null);
  const gpuP95 = rows.map((s) => s.latencyGpuMs.p95).filter((v): v is number => v != null);

  return {
    condition,
    language: 'all',
    n,
    toolSelectAccuracy: weighted((s) => s.toolSelectAccuracy, (s) => s.denominators.toolSelect),
    argExactMatchAccuracy: weighted(
      (s) => s.argExactMatchAccuracy,
      (s) => s.denominators.argExactMatch,
    ),
    absenceAccuracy: weighted((s) => s.absenceAccuracy, (s) => s.denominators.absence),
    parseFailureRate: n === 0 ? 0 : rows.reduce((sum, s) => sum + s.parseFailureRate * s.n, 0) / n,
    denominators: {
      toolSelect: rows.reduce((sum, s) => sum + s.denominators.toolSelect, 0),
      argExactMatch: rows.reduce((sum, s) => sum + s.denominators.argExactMatch, 0),
      absence: rows.reduce((sum, s) => sum + s.denominators.absence, 0),
    },
    envelope: {
      errors: rows.reduce((sum, s) => sum + (s.envelope?.errors ?? 0), 0),
      toolWouldMatch: rows.reduce((sum, s) => sum + (s.envelope?.toolWouldMatch ?? 0), 0),
    },
    // A median of medians, so it reads as an order of magnitude, not a p50.
    latencyGpuMs: {
      p50: gpuP50.length ? gpuP50.reduce((a, b) => a + b, 0) / gpuP50.length : null,
      p95: gpuP95.length ? Math.max(...gpuP95) : null,
    },
    latencyCpuMs: { p50: null, p95: null },
  };
}

export type MetricDelta = {
  toolSelectAccuracy: number | null;
  argExactMatchAccuracy: number | null;
  absenceAccuracy: number | null;
  parseFailureRate: number | null;
};

/** The four scores, in the order they are read. */
export const TOOL_METRICS = [
  'toolSelectAccuracy',
  'argExactMatchAccuracy',
  'absenceAccuracy',
  'parseFailureRate',
] as const;

export type ToolMetric = (typeof TOOL_METRICS)[number];

/**
 * A delta with the reason it is missing.
 *
 * An empty cell used to be a bare dash, and a dash cannot be told apart from a
 * zero that failed to render. Every case where two conditions cannot be
 * subtracted has a cause worth reading: usually one of them never returned a
 * parseable answer, so there was no accuracy to compare in the first place.
 */
export type DeltaCell = {
  value: number | null;
  missing: null | 'notRun' | 'neither' | 'newer' | 'older';
};

function metricOf(slice: ConditionSlice, metric: ToolMetric): number | null {
  return slice[metric];
}

export function deltaBetween(
  newer: ConditionSlice | null,
  older: ConditionSlice | null,
  metric: ToolMetric,
): DeltaCell {
  if (!newer || !older) return { value: null, missing: 'notRun' };
  const a = metricOf(newer, metric);
  const b = metricOf(older, metric);
  if (a == null && b == null) return { value: null, missing: 'neither' };
  if (a == null) return { value: null, missing: 'newer' };
  if (b == null) return { value: null, missing: 'older' };
  return { value: a - b, missing: null };
}

/** What the condition comparison amounts to, before anyone reads a number. */
export type ConditionReadout = {
  /** Nothing the model returned under `bare` could be parsed. */
  bareUnparseable: boolean;
  /** Percentage points of parse failure the contract removed, if measurable. */
  contractParseGain: number | null;
  /** True when the contract moved an accuracy, not just the parse rate. */
  contractChangedAccuracy: boolean;
};

export function readConditions(slices: ConditionSlice[]): ConditionReadout {
  const bare = rollUpCondition(slices, 'bare');
  const contract = rollUpCondition(slices, 'contract');

  const movedAccuracy =
    bare && contract
      ? (['toolSelectAccuracy', 'argExactMatchAccuracy', 'absenceAccuracy'] as const).some(
          (m) => {
            const d = deltaBetween(contract, bare, m);
            return d.value != null && Math.abs(d.value) > 1e-9;
          },
        )
      : false;

  return {
    bareUnparseable: bare != null && bare.n > 0 && bare.parseFailureRate >= 0.999,
    contractParseGain:
      bare && contract ? contract.parseFailureRate - bare.parseFailureRate : null,
    contractChangedAccuracy: movedAccuracy,
  };
}

export type ConditionDelta = {
  language: string;
  contractMinusBare: MetricDelta;
};

/** One reply, kept so a person can read it and vote on it. */
export type ToolRoutingExampleRecord = {
  taskId: string;
  language: string;
  condition: string;
  /** `core` offers six tools, `wide` eighteen including near neighbours. */
  toolset: string;
  /** Exact prompt sent to model; absent on legacy reports. */
  prompt?: string;
  raw: string;
  score: {
    toolSelectCorrect: boolean | null;
    argExactMatch: boolean | null;
    absenceCorrect: boolean | null;
    parseFailed: boolean;
    /** The parse failed on the wrapper alone; the call underneath was readable. */
    envelopeError?: boolean;
    envelopeToolWouldMatch?: boolean | null;
    latencyGpuMs: number | null;
  };
  error?: string;
};

/** How one model did on the tasks that offered a given toolset. */
export type ToolsetRow = {
  toolset: string;
  n: number;
  toolSelectAccuracy: number | null;
  argExactMatchAccuracy: number | null;
  absenceAccuracy: number | null;
  parseFailureRate: number;
};

/**
 * Split one condition's replies by how many tools the task offered.
 *
 * Six tools let a model be right by elimination, so a single averaged score
 * hides the thing worth knowing: whether accuracy survives a realistic toolbox.
 */
export function rollUpToolsets(
  examples: ToolRoutingExampleRecord[],
  condition: string,
): ToolsetRow[] {
  const rows = new Map<string, ToolRoutingExampleRecord[]>();
  for (const e of examples) {
    if (e.condition !== condition) continue;
    rows.set(e.toolset, [...(rows.get(e.toolset) ?? []), e]);
  }

  const rate = (list: ToolRoutingExampleRecord[], pick: (e: ToolRoutingExampleRecord) => boolean | null) => {
    let hits = 0;
    let total = 0;
    for (const e of list) {
      const v = pick(e);
      if (v == null) continue;
      total += 1;
      if (v) hits += 1;
    }
    return total === 0 ? null : hits / total;
  };

  return [...rows.entries()].map(([toolset, list]) => ({
    toolset,
    n: list.length,
    toolSelectAccuracy: rate(list, (e) => e.score.toolSelectCorrect),
    argExactMatchAccuracy: rate(list, (e) => e.score.argExactMatch),
    absenceAccuracy: rate(list, (e) => e.score.absenceCorrect),
    parseFailureRate: list.filter((e) => e.score.parseFailed).length / list.length,
  }));
}

export type ToolRoutingReport = {
  schema: string;
  createdAt: string;
  modelId: string;
  /** Null for hosted APIs, which never name the weights behind a slug. */
  hfRepoId: string | null;
  languageConstraints: string[];
  conditions: string[];
  slices: ConditionSlice[];
  deltas: ConditionDelta[];
  examples?: ToolRoutingExampleRecord[];
};

/** One model's outcome in a run. Reports and failures sit side by side. */
export type ToolRoutingModelResult = {
  modelId: string;
  label: string;
  report: ToolRoutingReport | null;
  error: string | null;
};

export type ToolRoutingRegistryModel = {
  id: string;
  hfRepoId: string;
  label: string;
  license: string;
  usable: true | 'eval_only';
  hybridSsm?: boolean;
  notes?: string;
};

export type ToolRoutingCatalog = {
  models: ToolRoutingRegistryModel[];
  defaultModelIds: string[];
  languages: string[];
  defaultLanguages: string[];
  stubTasks: {
    total: number;
    byLanguage: Record<string, number>;
    byToolset: Record<string, number>;
    byLanguageToolset: Record<string, Record<string, number>>;
  };
  /** How many tools each named toolset offers. */
  toolsets: { core: number; wide: number; full: number };
  vllmConfigured: boolean;
};

export function pct(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

export function num(v: number | null | undefined, digits = 2): string {
  if (v == null || Number.isNaN(v)) return '—';
  return v.toFixed(digits);
}

export function deltaPt(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${(v * 100).toFixed(1)} pt`;
}

export function ms(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—';
  return `${Math.round(v)} ms`;
}

export function downloadToolRoutingReport(report: ToolRoutingReport) {
  const blob = new Blob([`${JSON.stringify(report, null, 2)}\n`], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tool-routing-${report.modelId}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
