/**
 * A browser-side, growing shelf of finished Compare runs.
 *
 * The Compare page keeps a run in React state only, so switching model or
 * reloading loses it. To compare a dozen models over a week you need the runs
 * to stack somewhere that outlives the tab, and to fall out as one report you
 * can paste into a writeup. That store is localStorage: per-machine, no server
 * write, which is exactly the trade the user asked for.
 *
 * What is kept is the comparison-grade summary, not every sample. Persisting
 * each prediction would blow the ~5 MB localStorage budget after a handful of
 * runs and drown the signal; the numbers that decide a model are small.
 */
import {
  rollUpCondition,
  type ConditionSlice,
  type ToolRoutingModelResult,
  type ToolRoutingReport,
} from '@/components/compare/tool-routing';
import type { EvalRunResult } from '@/components/compare/types';

const STORAGE_KEY = 'redrob.compare.reports.v1';
/** A stack this long already covers "a dozen models"; older ones drop off. */
const MAX_REPORTS = 200;

export interface SavedEvalTarget {
  label: string;
  kind: 'model' | 'router';
  metric: string;
  n: number;
  quality: number;
  meanLatencyMs: number;
  tokensPerSec: number | null;
  precision: string | null;
}

export interface SavedEvalReport {
  id: string;
  kind: 'eval';
  savedAt: string;
  finishedAt: string;
  runId: string;
  modality: 'text' | 'image';
  datasetLabel: string;
  task: string;
  metric: string;
  sampleCount: number;
  scored: boolean;
  targets: SavedEvalTarget[];
}

export interface SavedToolModel {
  label: string;
  hfRepoId: string | null;
  n: number;
  toolSelectAccuracy: number | null;
  argExactMatchAccuracy: number | null;
  absenceAccuracy: number | null;
  parseFailureRate: number | null;
  /**
   * Of the parse failures, how many were only the wrapper, and how many of
   * those still picked the right tool. Kept in the saved report because the
   * comparison write-up turns on it: 0% tool select with every failure a
   * wrapper mistake is a different finding from a model that cannot route.
   */
  envelopeErrors: number;
  envelopeToolWouldMatch: number;
  latencyGpuP50Ms: number | null;
  error: string | null;
}

export interface SavedToolReport {
  id: string;
  kind: 'tool';
  savedAt: string;
  createdAt: string;
  languages: string[];
  models: SavedToolModel[];
}

export type SavedReport = SavedEvalReport | SavedToolReport;

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function listReports(): SavedReport[] {
  if (!canUseStorage()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSavedReport);
  } catch {
    return [];
  }
}

function isSavedReport(x: unknown): x is SavedReport {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    (r.kind === 'eval' || r.kind === 'tool') &&
    typeof r.savedAt === 'string'
  );
}

function writeReports(reports: SavedReport[]): void {
  if (!canUseStorage()) return;
  const trimmed = reports.slice(-MAX_REPORTS);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    /* quota or private mode: the run stays in memory, just not persisted */
  }
  invalidate();
}

/**
 * The `useSyncExternalStore` face of the shelf.
 *
 * The server has no localStorage, so it must render the empty shelf and the
 * browser must fill it in after hydration. Reading storage during render
 * instead makes the server and client disagree on the very first paint, which
 * is a hydration error. React's store hook is built for exactly this split: one
 * snapshot for the server, another for the browser.
 *
 * The snapshot is cached because the hook compares by identity, and a fresh
 * array from every call would look like a change on every render.
 */
const EMPTY_REPORTS: SavedReport[] = [];
let snapshot: SavedReport[] | null = null;
const listeners = new Set<() => void>();

function invalidate(): void {
  snapshot = null;
  for (const listener of listeners) listener();
}

/** Another tab saving a run should show up here without a reload. */
function onStorageEvent(event: StorageEvent): void {
  if (event.key === null || event.key === STORAGE_KEY) invalidate();
}

export function subscribeReports(onChange: () => void): () => void {
  if (listeners.size === 0 && typeof window !== 'undefined') {
    window.addEventListener('storage', onStorageEvent);
  }
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0 && typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorageEvent);
    }
  };
}

export function reportsSnapshot(): SavedReport[] {
  snapshot ??= listReports();
  return snapshot;
}

export function reportsServerSnapshot(): SavedReport[] {
  return EMPTY_REPORTS;
}

/**
 * Add a report, or replace the one with the same id.
 *
 * The id is derived from the run, not random, so a component that re-renders
 * after a run finishes upserts the same row instead of stacking duplicates.
 * Newest sorts last, matching the order runs arrive.
 */
export function upsertReport(report: SavedReport): SavedReport[] {
  const next = listReports().filter((r) => r.id !== report.id);
  next.push(report);
  writeReports(next);
  return next;
}

export function removeReport(id: string): SavedReport[] {
  const next = listReports().filter((r) => r.id !== id);
  writeReports(next);
  return next;
}

export function clearReports(): SavedReport[] {
  writeReports([]);
  return [];
}

/** The condition worth reporting, now that `bare` is gone: contract, else the fullest. */
function primaryConditionSlice(report: ToolRoutingReport): ConditionSlice | null {
  const conditions = report.conditions.length ? report.conditions : ['contract'];
  const rolled = conditions
    .map((c) => rollUpCondition(report.slices, c))
    .filter((s): s is ConditionSlice => s != null);
  if (rolled.length === 0) return null;
  return rolled.find((s) => s.condition === 'contract') ?? rolled.sort((a, b) => b.n - a.n)[0]!;
}

export function buildEvalReport(result: EvalRunResult): SavedEvalReport {
  const meta = result.meta;
  return {
    id: `eval:${meta.runId}`,
    kind: 'eval',
    savedAt: new Date().toISOString(),
    finishedAt: meta.finishedAt,
    runId: meta.runId,
    // The modality is not on meta; task tells text from image well enough for a label.
    modality: meta.task === 'image' ? 'image' : 'text',
    datasetLabel: meta.datasetLabel || meta.datasetId || 'prompts',
    task: meta.task,
    metric: meta.metric,
    sampleCount: meta.sampleCount,
    scored: meta.scored !== false,
    targets: result.targets.map((t) => ({
      label: t.label,
      kind: t.kind,
      metric: t.metric,
      n: t.n,
      quality: t.quality,
      meanLatencyMs: t.meanLatencyMs,
      tokensPerSec: t.tokensPerSec ?? null,
      precision: t.precision ?? null,
    })),
  };
}

/** Null when nothing in the run produced a usable report, so callers can skip the save. */
export function buildToolReport(
  results: ToolRoutingModelResult[],
  languages: string[],
): SavedToolReport | null {
  if (results.length === 0) return null;
  const createdAt =
    results.find((r) => r.report?.createdAt)?.report?.createdAt ?? new Date().toISOString();
  const models: SavedToolModel[] = results.map((r) => {
    const slice = r.report ? primaryConditionSlice(r.report) : null;
    return {
      label: r.label,
      hfRepoId: r.report?.hfRepoId ?? null,
      n: slice?.n ?? 0,
      toolSelectAccuracy: slice?.toolSelectAccuracy ?? null,
      argExactMatchAccuracy: slice?.argExactMatchAccuracy ?? null,
      absenceAccuracy: slice?.absenceAccuracy ?? null,
      parseFailureRate: slice ? slice.parseFailureRate : null,
      envelopeErrors: slice?.envelope?.errors ?? 0,
      envelopeToolWouldMatch: slice?.envelope?.toolWouldMatch ?? 0,
      latencyGpuP50Ms: slice?.latencyGpuMs.p50 ?? null,
      error: r.error,
    };
  });
  // The languages a run covered belong to the run, not each model; the first
  // report's constraints are authoritative and fall back to the requested set.
  const langs =
    results.find((r) => r.report?.languageConstraints?.length)?.report?.languageConstraints ??
    languages;
  return {
    id: `tool:${createdAt}:${models.map((m) => m.label).join('+')}`,
    kind: 'tool',
    savedAt: new Date().toISOString(),
    createdAt,
    languages: langs,
    models,
  };
}

function pctCell(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

function msCell(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—';
  return `${Math.round(v)} ms`;
}

function numCell(v: number | null | undefined, digits = 1): string {
  if (v == null || Number.isNaN(v)) return '—';
  return v.toFixed(digits);
}

/**
 * One markdown document over every saved run, grouped so the same task lines its
 * models up in a single table. This is the deliverable: paste it into the
 * comparison writeup, or hand it to a model to draft the prose.
 */
export function reportsToMarkdown(reports: SavedReport[]): string {
  if (reports.length === 0) return '# Model comparison\n\n_No saved runs yet._\n';

  const lines: string[] = ['# Model comparison', ''];
  lines.push(`_${reports.length} saved run${reports.length === 1 ? '' : 's'}, exported ${new Date().toISOString()}._`, '');

  const evals = reports.filter((r): r is SavedEvalReport => r.kind === 'eval');
  const tools = reports.filter((r): r is SavedToolReport => r.kind === 'tool');

  if (evals.length) {
    lines.push('## Eval', '');
    const byTask = new Map<string, SavedEvalReport[]>();
    for (const r of evals) {
      const key = `${r.datasetLabel} · ${r.task} (${r.metric})`;
      byTask.set(key, [...(byTask.get(key) ?? []), r]);
    }
    for (const [key, group] of byTask) {
      lines.push(`### ${key}`, '');
      lines.push('| Model | Quality | Latency (mean) | tok/s | Precision | n | Run |');
      lines.push('| --- | --- | --- | --- | --- | --- | --- |');
      for (const r of group) {
        const day = r.finishedAt.slice(0, 10);
        for (const t of r.targets) {
          lines.push(
            `| ${t.label} | ${r.scored ? pctCell(t.quality) : 'unscored'} | ${msCell(
              t.meanLatencyMs,
            )} | ${numCell(t.tokensPerSec)} | ${t.precision ?? '—'} | ${t.n} | ${day} |`,
          );
        }
      }
      lines.push('');
    }
  }

  if (tools.length) {
    lines.push('## Tool routing', '');
    for (const r of tools) {
      const day = r.createdAt.slice(0, 10);
      lines.push(`### ${day} · ${r.languages.join(', ') || 'all languages'}`, '');
      lines.push(
        '| Model | Tool select | Arg match | Absence | Parse fail | Wrong envelope (right tool) | Latency p50 | n |',
      );
      lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
      for (const m of r.models) {
        if (m.error) {
          lines.push(`| ${m.label} | error: ${m.error} | | | | | | |`);
          continue;
        }
        const envelope =
          (m.envelopeErrors ?? 0) === 0
            ? '—'
            : `${m.envelopeErrors} (${m.envelopeToolWouldMatch})`;
        lines.push(
          `| ${m.label} | ${pctCell(m.toolSelectAccuracy)} | ${pctCell(
            m.argExactMatchAccuracy,
          )} | ${pctCell(m.absenceAccuracy)} | ${pctCell(m.parseFailureRate)} | ${envelope} | ${msCell(
            m.latencyGpuP50Ms,
          )} | ${m.n} |`,
        );
      }
      lines.push('');
    }
  }

  return `${lines.join('\n')}\n`;
}

export function downloadMarkdown(markdown: string): void {
  const blob = new Blob([markdown], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `model-comparison-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  URL.revokeObjectURL(url);
}
