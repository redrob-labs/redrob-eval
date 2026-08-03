'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type {
  CompareResult,
  PublicModelEntry,
  TokenProfile,
  WeightPresetId,
  Weights,
} from '@redrob/harness';
import { CompareParetoChart } from '@/components/CompareParetoChart';

const WEIGHTS_KEY = 'redrob-compare-weights';
const GUIDE_KEY = 'redrob.compareGuideDismissed';

const PRESETS: Record<WeightPresetId, Weights> = {
  balanced: { quality: 0.3, preference: 0.2, cost: 0.3, speed: 0.2 },
  'cost-first': { quality: 0.2, preference: 0.1, cost: 0.5, speed: 0.2 },
  'quality-first': { quality: 0.5, preference: 0.25, cost: 0.15, speed: 0.1 },
  'latency-first': { quality: 0.2, preference: 0.1, cost: 0.2, speed: 0.5 },
};

const DEFAULT_PROFILE: TokenProfile = {
  uncachedInputTokens: 2000,
  cachedInputTokens: 0,
  outputTokens: 1000,
  parallelSections: 1,
  failureRate: 0,
  label: 'illustrative default — replace with your own trace',
};

function weightSum(w: Weights): number {
  return w.quality + w.preference + w.cost + w.speed;
}

function normalizeWeights(w: Weights): Weights {
  const sum = weightSum(w);
  if (sum <= 0) return { ...PRESETS.balanced };
  return {
    quality: w.quality / sum,
    preference: w.preference / sum,
    cost: w.cost / sum,
    speed: w.speed / sum,
  };
}

type SortKey =
  | 'rank'
  | 'composite'
  | 'relativeCostPct'
  | 'quality'
  | 'preference'
  | 'speed'
  | 'swing';

function fmt(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

function loadStoredWeights(): Weights {
  try {
    const raw = localStorage.getItem(WEIGHTS_KEY);
    if (!raw) return PRESETS.balanced;
    const parsed = JSON.parse(raw) as Weights;
    if (
      Number.isFinite(parsed.quality) &&
      Number.isFinite(parsed.preference) &&
      Number.isFinite(parsed.cost) &&
      Number.isFinite(parsed.speed)
    ) {
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return PRESETS.balanced;
}

export function ComparePanel() {
  const searchParams = useSearchParams();
  const [models, setModels] = useState<PublicModelEntry[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [baselineModelId, setBaselineModelId] = useState('');
  const [weights, setWeights] = useState<Weights>(PRESETS.balanced);
  const [profile, setProfile] = useState<TokenProfile>(DEFAULT_PROFILE);
  const [goodEnoughSeconds, setGoodEnoughSeconds] = useState(8);
  const [qualitySource, setQualitySource] = useState<'registry' | 'run'>('registry');
  const [runId, setRunId] = useState('');
  const [split, setSplit] = useState<'val' | 'test'>('val');
  const [result, setResult] = useState<CompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('rank');
  const [sortAsc, setSortAsc] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [handoffNote, setHandoffNote] = useState<string | null>(null);
  const [registryLoaded, setRegistryLoaded] = useState(false);
  const [showGuide, setShowGuide] = useState(true);

  useEffect(() => {
    setWeights(loadStoredWeights());
    try {
      if (localStorage.getItem(GUIDE_KEY) === '1') setShowGuide(false);
    } catch {
      /* ignore */
    }
  }, []);

  const dismissGuide = useCallback(() => {
    setShowGuide(false);
    try {
      localStorage.setItem(GUIDE_KEY, '1');
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    const qSource = searchParams.get('qualitySource');
    const qRun = searchParams.get('runId');
    if (qSource === 'run' && qRun) {
      setQualitySource('run');
      setRunId(qRun);
      setHandoffNote(
        `Quality from Evolve run ${qRun} — adjust models/weights if needed, then Rank models.`,
      );
    }
  }, [searchParams]);

  useEffect(() => {
    try {
      localStorage.setItem(WEIGHTS_KEY, JSON.stringify(weights));
    } catch {
      /* ignore */
    }
  }, [weights]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/compare/registry');
        const json = (await res.json()) as { models?: PublicModelEntry[]; note?: string };
        const list = json.models ?? [];
        setModels(list);
        setNote(json.note ?? null);
        setSelected(list.map((m) => m.id));
        const preferred = list.find((m) => m.id.includes('gpt-4o') && !m.id.includes('mini'));
        setBaselineModelId(preferred?.id ?? list[0]?.id ?? '');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load registry');
      } finally {
        setRegistryLoaded(true);
      }
    })();
  }, []);

  const runCompare = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const normalized = normalizeWeights(weights);
      setWeights(normalized);
      const res = await fetch('/api/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelIds: selected,
          baselineModelId,
          tokenProfile: profile,
          weights: normalized,
          qualitySource,
          runId: qualitySource === 'run' ? runId.trim() || undefined : undefined,
          split: qualitySource === 'run' ? split : undefined,
          goodEnoughSeconds,
        }),
      });
      const json = (await res.json()) as CompareResult & { error?: string };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setResult(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Compare failed');
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [
    selected,
    baselineModelId,
    profile,
    weights,
    qualitySource,
    runId,
    split,
    goodEnoughSeconds,
  ]);

  const sorted = useMemo(() => {
    if (!result) return [];
    const rows = [...result.ranked];
    const dir = sortAsc ? 1 : -1;
    rows.sort((a, b) => {
      const val = (r: (typeof rows)[0]): number => {
        switch (sortKey) {
          case 'rank':
            return r.rank;
          case 'composite':
            return r.composite.score ?? -Infinity;
          case 'relativeCostPct':
            return r.axes.relativeCostPct ?? Infinity;
          case 'quality':
            return r.axes.quality.score ?? -Infinity;
          case 'preference':
            return r.axes.preference.score ?? -Infinity;
          case 'speed':
            return r.axes.speed.score ?? -Infinity;
          case 'swing':
            return r.rankSwing;
          default:
            return r.rank;
        }
      };
      const d = val(a) - val(b);
      if (d !== 0) return d * dir;
      return a.rank - b.rank;
    });
    return rows;
  }, [result, sortKey, sortAsc]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      setSortAsc(key === 'rank' || key === 'relativeCostPct' || key === 'swing');
    }
  }

  function applyPreset(id: WeightPresetId) {
    setWeights(PRESETS[id]);
  }

  function toggleModel(id: string) {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function selectAllModels() {
    setSelected(models.map((m) => m.id));
  }

  const exportHref =
    result != null
      ? null // use POST download
      : null;

  async function downloadMd() {
    const normalized = normalizeWeights(weights);
    setWeights(normalized);
    const res = await fetch('/api/compare?export=md', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modelIds: selected,
        baselineModelId,
        tokenProfile: profile,
        weights: normalized,
        qualitySource,
        runId: qualitySource === 'run' ? runId.trim() || undefined : undefined,
        split: qualitySource === 'run' ? split : undefined,
        goodEnoughSeconds,
        exportMd: true,
      }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      setError(err.error || `Export failed (${res.status})`);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'compare-report.md';
    a.click();
    URL.revokeObjectURL(url);
  }

  void exportHref;

  const weightsTotal = weightSum(weights);
  const weightsNormalized = Math.abs(weightsTotal - 1) < 0.001;
  const rankBlockedReason = loading
    ? 'Scoring…'
    : selected.length === 0
      ? 'Select at least one model.'
      : !baselineModelId
        ? 'Pick a baseline model.'
        : null;

  return (
    <div className="compare-panel flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-xl font-bold text-slate-900">
            Compare
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Rank candidates on quality, preference, cost, and latency under your token profile.
            Cost is always % of baseline — never absolute currency.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex gap-2">
            <button
              type="button"
              className="app-run-btn"
              disabled={Boolean(rankBlockedReason)}
              title={rankBlockedReason ?? undefined}
              onClick={() => void runCompare()}
            >
              {loading ? 'Scoring…' : 'Rank models'}
            </button>
            <button
              type="button"
              className="app-ghost-btn"
              disabled={!result}
              onClick={() => void downloadMd()}
            >
              Export md
            </button>
          </div>
          {rankBlockedReason && !loading ? (
            <p className="cta-disabled-hint text-right">{rankBlockedReason}</p>
          ) : null}
        </div>
      </div>

      {showGuide ? (
        <div className="module-guide" role="region" aria-label="Compare guide">
          <div className="module-guide-head">
            <strong>Compare guide</strong>
            <button type="button" className="app-ghost-btn" onClick={dismissGuide}>
              Dismiss
            </button>
          </div>
          <ol>
            <li>Select models and a baseline (100% cost).</li>
            <li>Adjust weight presets or sliders — Σ normalizes when you Rank.</li>
            <li>Set a token profile that matches your workload, then Rank models.</li>
          </ol>
        </div>
      ) : null}

      {handoffNote ? <div className="app-banner warn">{handoffNote}</div> : null}
      {note ? <p className="text-xs text-amber-800/80">{note}</p> : null}
      {error ? <div className="app-banner error">{error}</div> : null}

      {registryLoaded && models.length === 0 ? (
        <div className="pref-empty">
          <p>No registry models loaded.</p>
          <button type="button" className="app-run-btn" onClick={() => window.location.reload()}>
            Reload page
          </button>
        </div>
      ) : null}

      {registryLoaded && models.length > 0 && selected.length === 0 ? (
        <div className="app-banner warn">
          No models selected —{' '}
          <button type="button" className="underline" onClick={selectAllModels}>
            select all
          </button>{' '}
          then Rank models.
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <section className="space-y-3 rounded-lg border border-slate-200 bg-white/60 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="pane-label">Models</div>
            {models.length > 0 ? (
              <button type="button" className="app-ghost-btn text-xs" onClick={selectAllModels}>
                Select all
              </button>
            ) : null}
          </div>
          <ul className="max-h-56 space-y-1 overflow-auto text-sm">
            {models.map((m) => (
              <li key={m.id} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={selected.includes(m.id)}
                  onChange={() => toggleModel(m.id)}
                  id={`cmp-${m.id}`}
                />
                <label htmlFor={`cmp-${m.id}`} className="cursor-pointer leading-snug">
                  <span className="font-medium text-slate-800">{m.label}</span>
                  <span className="ml-1 text-xs text-slate-500">{m.provider}</span>
                  {!m.hasCachedInputRate ? (
                    <span
                      className="ml-1 rounded bg-amber-100 px-1 text-[10px] text-amber-900"
                      title="No published cache input rate — cost may be an upper bound"
                    >
                      no cache rate
                    </span>
                  ) : null}
                  {!m.hasArenaElo || !m.hasPublishedLatency ? (
                    <span
                      className="ml-1 rounded bg-slate-100 px-1 text-[10px] text-slate-600"
                      title="Some published axes missing — not imputed"
                    >
                      incomplete
                    </span>
                  ) : null}
                </label>
              </li>
            ))}
          </ul>

          <label className="block text-xs text-slate-600">
            Baseline (100% cost)
            <select
              className="mt-1 w-full rounded border border-slate-200 bg-white px-2 py-1.5 text-sm"
              value={baselineModelId}
              onChange={(e) => setBaselineModelId(e.target.value)}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="pane-label">Weights</div>
            <span className="text-[11px] text-slate-500">
              Σ {weightsTotal.toFixed(2)}
              {weightsNormalized ? (
                ' · normalized'
              ) : (
                <>
                  {' · '}
                  <button
                    type="button"
                    className="underline"
                    onClick={() => setWeights(normalizeWeights(weights))}
                  >
                    normalize to 1
                  </button>
                </>
              )}
            </span>
          </div>
          <div className="flex flex-wrap gap-1">
            {(Object.keys(PRESETS) as WeightPresetId[]).map((id) => (
              <button
                key={id}
                type="button"
                className="app-ghost-btn text-xs"
                onClick={() => applyPreset(id)}
              >
                {id}
              </button>
            ))}
          </div>
          {(
            [
              ['quality', 'Quality'],
              ['preference', 'Preference'],
              ['cost', 'Cost'],
              ['speed', 'Speed'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="block text-xs text-slate-600">
              {label} ({weights[key].toFixed(2)})
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={weights[key]}
                className="mt-1 w-full"
                onChange={(e) =>
                  setWeights((w) => ({ ...w, [key]: Number(e.target.value) }))
                }
              />
            </label>
          ))}

          <div className="pane-label">Token profile</div>
          <p className="text-[11px] text-slate-500">{profile.label}</p>
          {(
            [
              ['uncachedInputTokens', 'Uncached in'],
              ['cachedInputTokens', 'Cached in'],
              ['outputTokens', 'Output'],
              ['parallelSections', 'Parallel sections'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="block text-xs text-slate-600">
              {label}
              <input
                type="number"
                min={key === 'parallelSections' ? 1 : 0}
                className="mt-1 w-full rounded border border-slate-200 px-2 py-1 text-sm"
                value={profile[key]}
                onChange={(e) =>
                  setProfile((p) => ({
                    ...p,
                    [key]: Number(e.target.value),
                    label:
                      p.label.includes('illustrative default') || p.label.includes('custom')
                        ? 'custom profile'
                        : p.label,
                  }))
                }
              />
            </label>
          ))}
          <label className="block text-xs text-slate-600">
            Failure rate (0–1)
            <input
              type="number"
              min={0}
              max={0.999}
              step={0.01}
              className="mt-1 w-full rounded border border-slate-200 px-2 py-1 text-sm"
              value={profile.failureRate}
              onChange={(e) =>
                setProfile((p) => ({ ...p, failureRate: Number(e.target.value) }))
              }
            />
          </label>
          <label className="block text-xs text-slate-600">
            Good-enough latency ceiling (s)
            <input
              type="number"
              min={0.1}
              step={0.5}
              className="mt-1 w-full rounded border border-slate-200 px-2 py-1 text-sm"
              value={goodEnoughSeconds}
              onChange={(e) => setGoodEnoughSeconds(Number(e.target.value))}
            />
          </label>

          <div className="pane-label">Quality source</div>
          <div className="flex gap-3 text-sm">
            <label className="inline-flex items-center gap-1.5">
              <input
                type="radio"
                checked={qualitySource === 'registry'}
                onChange={() => setQualitySource('registry')}
              />
              Registry composite
            </label>
            <label className="inline-flex items-center gap-1.5">
              <input
                type="radio"
                checked={qualitySource === 'run'}
                onChange={() => setQualitySource('run')}
              />
              Optimize run
            </label>
          </div>
          {qualitySource === 'run' ? (
            <div className="space-y-2">
              <label className="block text-xs text-slate-600">
                Optimize run id
                <input
                  className="mt-1 w-full rounded border border-slate-200 px-2 py-1 text-sm"
                  value={runId}
                  onChange={(e) => setRunId(e.target.value)}
                  placeholder="2026-…_…_…"
                />
              </label>
              <label className="block text-xs text-slate-600">
                Split
                <select
                  className="mt-1 w-full rounded border border-slate-200 px-2 py-1.5 text-sm"
                  value={split}
                  onChange={(e) => setSplit(e.target.value as 'val' | 'test')}
                >
                  <option value="val">val</option>
                  <option value="test">test (refused if optimized against)</option>
                </select>
              </label>
            </div>
          ) : null}
        </section>

        <section className="space-y-3 rounded-lg border border-slate-200 bg-white/60 p-3">
          <div className="pane-label">Ranking</div>
          {result ? (
            <>
              <p className="text-xs text-slate-600">
                {result.qualityAxisLabel}
                {result.correlation.rSquared != null
                  ? ` · quality↔preference r²=${result.correlation.rSquared.toFixed(3)}`
                  : ` · ${result.correlation.feedback}`}
              </p>
              <div className="table-scroll">
                <table className="data-table text-xs">
                  <thead>
                    <tr>
                      {(
                        [
                          ['rank', 'Rank'],
                          ['composite', 'Composite'],
                          ['relativeCostPct', 'Rel. cost %'],
                          ['quality', 'Quality'],
                          ['preference', 'Pref'],
                          ['speed', 'Speed'],
                          ['swing', 'Swing'],
                        ] as const
                      ).map(([key, label]) => (
                        <th key={key}>
                          <button type="button" className="underline-offset-2 hover:underline" onClick={() => toggleSort(key)}>
                            {label}
                            {sortKey === key ? (sortAsc ? ' ↑' : ' ↓') : ''}
                          </button>
                        </th>
                      ))}
                      <th>Model</th>
                      <th>Flags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((r) => (
                      <tr key={r.modelId}>
                        <td>{r.rank}</td>
                        <td title={r.composite.feedback}>{fmt(r.composite.score)}</td>
                        <td title={r.axes.cost.feedback}>
                          {fmt(r.axes.relativeCostPct)}
                          {r.axes.cost.upperBound ? '†' : ''}
                        </td>
                        <td title={r.axes.quality.feedback}>{fmt(r.axes.quality.score)}</td>
                        <td title={r.axes.preference.feedback}>{fmt(r.axes.preference.score)}</td>
                        <td title={r.axes.speed.feedback}>{fmt(r.axes.speed.score)}</td>
                        <td>{r.rankSwing}</td>
                        <td>
                          <strong>{r.label}</strong>
                          <div className="text-[10px] text-slate-400">{r.modelId}</div>
                        </td>
                        <td>
                          {r.onParetoFrontier ? (
                            <span className="mr-1 rounded bg-teal-100 px-1 text-teal-900">frontier</span>
                          ) : null}
                          {r.missingAxes.length > 0 ? (
                            <span
                              className="rounded bg-amber-100 px-1 text-amber-900"
                              title={`Missing: ${r.missingAxes.join(', ')}. Weights renormalized — not comparable to full-axis rows.`}
                            >
                              {r.missingAxes.length}/4 axes
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-slate-500">
                † Upper-bound cost when cache input rate is unpublished. Hover cells for source feedback.
                Swing = rank range across weight presets.
              </p>
              <div className="pane-label">Pareto</div>
              <CompareParetoChart ranked={result.ranked} />
              {result.notes.length > 0 ? (
                <ul className="list-disc pl-4 text-xs text-slate-600">
                  {result.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <div className="pref-empty">
              <p>No ranking yet. Select models, set a baseline, then rank.</p>
              <button
                type="button"
                className="app-run-btn"
                disabled={loading || selected.length === 0 || !baselineModelId}
                onClick={() => void runCompare()}
              >
                Rank models
              </button>
              <p className="field-hint">
                Registry:{' '}
                <code className="text-xs">
                  packages/harness/src/lib/compare/registry/models.json
                </code>
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
