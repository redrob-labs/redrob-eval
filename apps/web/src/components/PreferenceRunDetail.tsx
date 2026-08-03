'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

export type PreferenceGenerationRow = {
  modelId: string;
  inputId: string;
  output: string;
  finishReason: string;
  error?: string;
  usage?: {
    outputTokens?: number;
    reasoningTokens?: number;
  };
};

export type PreferenceRunSummaryView = {
  runId: string;
  truncationWarning: boolean;
  truncationWarningMessage?: string;
  completion?: {
    completed: number;
    total: number;
    cells?: Record<string, Record<string, string>>;
  };
  byModel?: {
    modelId: string;
    ok?: number;
    truncationRate: number;
    meanOutputTokens: number;
  }[];
};

export type PreferenceRunDetailView = {
  meta?: {
    id: string;
    status: string;
    modelIds: string[];
    inputIds: string[];
    error?: string;
    generationParams?: {
      temperature: number;
      maxTokens: number | null;
      parallelSections: number;
    };
  };
  summary?: PreferenceRunSummaryView | null;
  generations?: PreferenceGenerationRow[];
  truncationWarning?: boolean;
  truncationWarningMessage?: string;
};

type ProgressState = {
  done: number;
  total: number;
  statusLine: string;
};

type Props = {
  runId: string;
  /** Full-page layout: taller matrix, no nested card chrome */
  layout?: 'panel' | 'page';
  onStatus?: (status: string) => void;
};

export function PreferenceRunDetail({ runId, layout = 'panel', onStatus }: Props) {
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  const [detail, setDetail] = useState<PreferenceRunDetailView | null>(null);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;

    setLoading(true);
    setError(null);
    setProgress(null);
    setDetail(null);

    async function loadDetail(includeGenerations: boolean) {
      const q = includeGenerations ? '?generations=1' : '';
      const res = await fetch(
        `/api/preference/runs/${encodeURIComponent(runId)}${q}`,
      );
      const json = (await res.json()) as PreferenceRunDetailView & { error?: string };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      if (cancelled) return json;
      setDetail(json);
      return json;
    }

    void (async () => {
      try {
        const json = await loadDetail(false);
        if (cancelled) return;
        const status = json.meta?.status;
        if (status === 'ready' || status === 'failed' || status === 'stopped') {
          await loadDetail(true);
          if (!cancelled) {
            setLoading(false);
            if (status) onStatusRef.current?.(status);
          }
          return;
        }
        if (!cancelled) setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load run');
          setLoading(false);
        }
      }
    })();

    es = new EventSource(
      `/api/preference/runs/${encodeURIComponent(runId)}/events`,
    );
    es.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as {
          type: string;
          done?: number;
          total?: number;
          message?: string;
          modelId?: string;
          inputId?: string;
          status?: string;
        };
        if (event.type === 'start') {
          setProgress({
            done: 0,
            total: event.total ?? 0,
            statusLine: 'Generating…',
          });
        } else if (event.type === 'cell') {
          setProgress({
            done: event.done ?? 0,
            total: event.total ?? 0,
            statusLine: `${event.modelId} · ${event.inputId} · ${event.status}`,
          });
          setLoading(false);
        } else if (event.type === 'done') {
          setProgress((p) =>
            p
              ? { ...p, done: p.total, statusLine: 'Complete' }
              : { done: 1, total: 1, statusLine: 'Complete' },
          );
          void (async () => {
            try {
              await loadDetail(true);
            } catch (e) {
              if (!cancelled) {
                setError(e instanceof Error ? e.message : 'Failed to load results');
              }
            } finally {
              if (!cancelled) setLoading(false);
            }
            onStatusRef.current?.('ready');
          })();
          es?.close();
        } else if (event.type === 'error') {
          setError(event.message || 'Run failed');
          setLoading(false);
          onStatusRef.current?.('failed');
          void loadDetail(false);
          es?.close();
        } else if (event.type === 'cancelled') {
          setProgress((p) =>
            p ? { ...p, statusLine: 'Stopped' } : { done: 0, total: 0, statusLine: 'Stopped' },
          );
          void (async () => {
            try {
              await loadDetail(true);
            } finally {
              if (!cancelled) setLoading(false);
            }
            onStatusRef.current?.('stopped');
          })();
          es?.close();
        }
      } catch {
        // ignore malformed
      }
    };
    es.onerror = () => {
      void (async () => {
        try {
          const res = await fetch(
            `/api/preference/runs/${encodeURIComponent(runId)}`,
          );
          if (!res.ok || cancelled) return;
          const json = (await res.json()) as PreferenceRunDetailView;
          const status = json.meta?.status;
          if (
            status === 'ready' ||
            status === 'failed' ||
            status === 'stopped'
          ) {
            setDetail(json);
            if (status === 'ready' || status === 'stopped') {
              await loadDetail(true);
            }
            setLoading(false);
            es?.close();
            onStatusRef.current?.(status);
          }
        } catch {
          // keep waiting
        }
      })();
    };

    return () => {
      cancelled = true;
      es?.close();
    };
  }, [runId]);

  const summary = detail?.summary;
  const generations = detail?.generations ?? [];
  const truncation =
    detail?.truncationWarning || summary?.truncationWarning;
  const maxTokensUsed = detail?.meta?.generationParams?.maxTokens;
  const maxLabel =
    maxTokensUsed === null
      ? 'unlimited'
      : maxTokensUsed != null
        ? `max ${maxTokensUsed}`
        : null;
  const pct =
    progress && progress.total > 0
      ? Math.round((100 * progress.done) / progress.total)
      : summary?.completion && summary.completion.total > 0
        ? Math.round(
            (100 * summary.completion.completed) / summary.completion.total,
          )
        : null;

  const modelIds =
    detail?.meta?.modelIds ??
    summary?.byModel?.map((m) => m.modelId) ??
    Array.from(new Set(generations.map((g) => g.modelId)));
  const inputIds =
    detail?.meta?.inputIds ??
    Array.from(new Set(generations.map((g) => g.inputId)));
  const byCell = new Map(
    generations.map((g) => [`${g.modelId}\0${g.inputId}`, g] as const),
  );
  const statsByModel = new Map(
    (summary?.byModel ?? []).map((m) => [m.modelId, m] as const),
  );
  const cells =
    summary?.completion?.cells ?? detail?.summary?.completion?.cells;

  const raiseHref =
    maxTokensUsed == null
      ? '/preference'
      : `/preference?maxTokens=${Math.max(maxTokensUsed * 2, 8192)}`;

  return (
    <div className={`pref-results${layout === 'page' ? ' pref-results-page' : ''}`}>
      <div className="pref-models-heading">
        <div className="pane-label">Results</div>
        <span className="pref-models-count">
          {detail?.meta?.status ?? (loading ? 'loading' : '—')}
          {pct != null ? ` · ${pct}%` : ''}
          {maxLabel ? ` · ${maxLabel}` : ''}
        </span>
      </div>
      <p className="field-hint pref-results-id">{runId}</p>

      {error ? <div className="app-banner error">{error}</div> : null}
      {truncation ? (
        <div className="app-banner warn">
          <p>
            {detail?.truncationWarningMessage ||
              summary?.truncationWarningMessage ||
              'Truncation detected — raise max tokens before voting.'}
          </p>
          <Link href={raiseHref} className="app-ghost-btn" style={{ marginTop: '0.5rem' }}>
            {maxTokensUsed == null
              ? 'New run · keep unlimited'
              : `New run · max tokens ${Math.max(maxTokensUsed * 2, 8192)}`}
          </Link>
        </div>
      ) : null}

      {progress ? (
        <div className="pref-progress">
          <div className="pref-progress-track">
            <div
              className="pref-progress-bar"
              style={{ width: `${pct ?? 0}%` }}
            />
          </div>
          <p className="field-hint">
            {progress.statusLine}
            {progress.total > 0
              ? ` · ${progress.done}/${progress.total}`
              : ''}
          </p>
        </div>
      ) : null}

      {modelIds.length === 0 && generations.length === 0 ? (
        loading && !detail ? (
          <p className="field-hint">Loading run…</p>
        ) : detail?.meta?.status === 'running' ||
          detail?.meta?.status === 'queued' ? (
          <p className="field-hint">Waiting for completions…</p>
        ) : loading ? (
          <p className="field-hint">Loading outputs…</p>
        ) : (
          <p className="field-hint">No generation rows yet.</p>
        )
      ) : (
        <div className="pref-results-tables">
          {summary?.byModel && summary.byModel.length > 0 ? (
            <div className="table-scroll">
              <table className="data-table text-xs">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>OK</th>
                    <th>Trunc %</th>
                    <th>Mean out</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.byModel.map((m) => (
                    <tr key={m.modelId}>
                      <td className="pref-model-cell">{m.modelId}</td>
                      <td>{m.ok ?? '—'}</td>
                      <td>
                        {m.truncationRate > 0 ? (
                          <span className="pref-trunc-warn">
                            {(100 * m.truncationRate).toFixed(0)}%
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>{m.meanOutputTokens.toFixed(0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <div className="pane-label">Outputs</div>
          <div className="table-scroll pref-output-matrix-wrap">
            <table className="data-table text-xs pref-output-matrix">
              <thead>
                <tr>
                  <th className="pref-input-col">Input</th>
                  {modelIds.map((id) => {
                    const s = statsByModel.get(id);
                    return (
                      <th key={id}>
                        <div className="pref-matrix-model">{id}</div>
                        {s ? (
                          <div className="pref-matrix-model-meta">
                            trunc{' '}
                            {s.truncationRate > 0
                              ? `${(100 * s.truncationRate).toFixed(0)}%`
                              : '—'}
                            {' · '}
                            μ {s.meanOutputTokens.toFixed(0)} tok
                          </div>
                        ) : null}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {inputIds.map((inputId) => (
                  <tr key={inputId}>
                    <th scope="row" className="pref-input-col">
                      {inputId}
                    </th>
                    {modelIds.map((modelId) => {
                      const g = byCell.get(`${modelId}\0${inputId}`);
                      const cellStatus = cells?.[modelId]?.[inputId];
                      if (!g) {
                        return (
                          <td key={modelId} className="pref-matrix-empty">
                            {cellStatus === 'pending' || !cellStatus
                              ? '…'
                              : cellStatus}
                          </td>
                        );
                      }
                      const tone = g.error
                        ? 'error'
                        : g.finishReason === 'length' ||
                            g.finishReason.includes('max_token')
                          ? 'trunc'
                          : 'ok';
                      return (
                        <td key={modelId} className={`pref-matrix-cell ${tone}`}>
                          <div className="pref-matrix-cell-meta">
                            {g.error ? (
                              <span className="pref-trunc-warn">error</span>
                            ) : (
                              <span>{g.finishReason || '—'}</span>
                            )}
                            {g.usage?.outputTokens != null ? (
                              <span>{g.usage.outputTokens} tok</span>
                            ) : null}
                            {g.usage?.reasoningTokens ? (
                              <span>+{g.usage.reasoningTokens} reason</span>
                            ) : null}
                          </div>
                          <pre className="pref-matrix-output">
                            {g.error || g.output || '—'}
                          </pre>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
