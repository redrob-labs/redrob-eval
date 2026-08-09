/**
 * Racing several seed models through GEPA at once.
 *
 * A single run answers "did this prompt get better on this model". It cannot answer the
 * question people actually have, which is which model to ship the evolved prompt on —
 * and the answer is not always the strongest model, nor the one that improved most. Run
 * live on a compatibility-report goal, Llama 3.1 8B gained the most (+16 points) and
 * still finished last on held-out test, because it had the most room to gain; a model
 * that started at 86% gained nothing and won.
 *
 * Each model gets its own optimize run, started together and streamed independently, so
 * the comparison is between finished runs rather than between snapshots taken at
 * whatever moment each happened to reach. They are ordinary optimize runs: nothing here
 * is a second implementation of the search.
 */
import type { OptimizeEvent } from '@redrob/harness';

export type ArenaStatus = 'queued' | 'running' | 'done' | 'failed' | 'stopped';

export interface ArenaEntry {
  modelId: string;
  label: string;
  runId: string | null;
  status: ArenaStatus;
  error?: string;
  /** Rollouts observed so far, against the budget every entry shares. */
  rollouts: number;
  maxRollouts: number;
  baselineQuality: number | null;
  evolvedQuality: number | null;
  testQuality: number | null;
  baselineTokens: number | null;
  evolvedTokens: number | null;
  /** Mean per rubric dimension for the evolved candidate, in [0,1]. */
  dimensions?: Record<string, number>;
  baselineDimensions?: Record<string, number>;
  instruction?: string;
}

export function newEntry(modelId: string, label: string, maxRollouts: number): ArenaEntry {
  return {
    modelId,
    label,
    runId: null,
    status: 'queued',
    rollouts: 0,
    maxRollouts,
    baselineQuality: null,
    evolvedQuality: null,
    testQuality: null,
    baselineTokens: null,
    evolvedTokens: null,
  };
}

/**
 * Improvement in quality, or null while either end is unknown.
 *
 * Deliberately not defaulted to zero for a run still in flight: "no change yet" and "no
 * change" would then look identical in the table, and the first is not a result.
 */
export function delta(entry: ArenaEntry): number | null {
  if (entry.baselineQuality == null || entry.evolvedQuality == null) return null;
  return entry.evolvedQuality - entry.baselineQuality;
}

/**
 * Best first, by the score on held-out test where there is one.
 *
 * Test rather than validation because validation is what the search optimised against,
 * and ranking models by the number they were fitted to would flatter whichever one
 * overfitted hardest. Not by improvement either: that ranks by how bad the model started.
 * Entries with no test score sort last — an unfinished run has not earned a position.
 */
export function rankEntries(entries: ArenaEntry[]): ArenaEntry[] {
  const key = (e: ArenaEntry) => e.testQuality ?? e.evolvedQuality;
  return [...entries].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka == null && kb == null) return a.label.localeCompare(b.label);
    if (ka == null) return 1;
    if (kb == null) return -1;
    return kb - ka;
  });
}

/** Apply one streamed event to an entry, returning the updated copy. */
export function applyEvent(entry: ArenaEntry, event: OptimizeEvent): ArenaEntry {
  switch (event.type) {
    case 'start':
      return { ...entry, status: 'running', maxRollouts: event.maxRollouts, rollouts: 0 };
    case 'rollout':
      return { ...entry, status: 'running', rollouts: Math.max(entry.rollouts, event.index + 1) };
    case 'done': {
      const done = event as Extract<OptimizeEvent, { type: 'done' }>;
      return {
        ...entry,
        status: 'done',
        baselineQuality: done.baselineVal?.quality ?? entry.baselineQuality,
        evolvedQuality: done.bestVal?.quality ?? entry.evolvedQuality,
        testQuality: done.test?.quality ?? entry.testQuality,
        baselineTokens: done.baselineVal?.totalTokens ?? entry.baselineTokens,
        evolvedTokens: done.bestVal?.totalTokens ?? entry.evolvedTokens,
        baselineDimensions: done.baselineVal?.dimensions ?? entry.baselineDimensions,
        dimensions: done.bestVal?.dimensions ?? entry.dimensions,
        instruction: done.best?.instruction ?? entry.instruction,
        rollouts: done.rollouts ?? entry.rollouts,
      };
    }
    case 'error':
      return { ...entry, status: 'failed', error: event.message };
    case 'cancelled':
      return { ...entry, status: 'stopped' };
    default:
      return entry;
  }
}

/**
 * Read one run's event stream, handing each event to `onEvent`.
 *
 * Separate from the single-run consumer in EvalApp on purpose: that one writes into the
 * page's own progress and frontier state, which several concurrent runs would fight over.
 */
export async function streamRun(
  runId: string,
  signal: AbortSignal,
  onEvent: (event: OptimizeEvent) => void,
): Promise<void> {
  const res = await fetch(`/api/optimize/runs/${encodeURIComponent(runId)}/events`, {
    signal,
    headers: { Accept: 'text/event-stream' },
  });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      const line = chunk
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('data:'));
      if (!line) continue;
      try {
        onEvent(JSON.parse(line.slice(5).trim()) as OptimizeEvent);
      } catch {
        // A malformed frame is not worth abandoning the run over.
      }
    }
  }
}
