'use client';

import { useMemo, useState } from 'react';
import type { EvalRunResult, EvalTargetSummary } from './types';

function fmtMs(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${Math.round(v)} ms`;
}

function fmtTokS(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v.toFixed(1)} tok/s`;
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

export function RunStage(props: {
  running: boolean;
  progress: { done: number; total: number } | null;
  targets: EvalTargetSummary[];
  result: EvalRunResult | null;
  scored: boolean;
  error: string | null;
  onStop: () => void;
  onBackToSetup: () => void;
  onStartPreference: () => void;
  preferenceReady: boolean;
}) {
  const {
    running,
    progress,
    targets,
    result,
    scored,
    error,
    onStop,
    onBackToSetup,
    onStartPreference,
    preferenceReady,
  } = props;
  const [openTarget, setOpenTarget] = useState<string | null>(null);

  const ranked = useMemo(() => {
    const rows = result?.targets ?? targets;
    return rows
      .slice()
      .sort((a, b) =>
        scored ? b.quality - a.quality : a.meanLatencyMs - b.meanLatencyMs,
      );
  }, [result, targets, scored]);

  const pct = progress && progress.total > 0 ? progress.done / progress.total : 0;

  return (
    <div className="cmp-run">
      <section className="cmp-card">
        <div className="cmp-run-head">
          <div>
            <div className="pane-label">
              {running ? 'Running' : result ? 'Results' : 'Run'}
            </div>
            <p className="field-hint">
              {scored
                ? 'Quality is measured against reference answers; latency and throughput are measured on this run.'
                : 'No reference answers, so speed is measured but quality has to come from preference votes.'}
            </p>
          </div>
          <div className="cmp-run-actions">
            {running ? (
              <button type="button" className="app-ghost-btn" onClick={onStop}>
                Stop
              </button>
            ) : (
              <button type="button" className="app-ghost-btn" onClick={onBackToSetup}>
                Back to setup
              </button>
            )}
          </div>
        </div>

        {progress ? (
          <div className="cmp-progress">
            <div className="cmp-progress-bar">
              <div className="cmp-progress-fill" style={{ width: `${pct * 100}%` }} />
            </div>
            <span>
              {progress.done} / {progress.total} calls
            </span>
          </div>
        ) : null}

        {error ? <div className="app-banner error">{error}</div> : null}
      </section>

      {ranked.length > 0 ? (
        <section className="cmp-card">
          <div className="pane-label">Ranking</div>
          <div className="table-scroll">
            <table className="data-table text-xs">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Model</th>
                  <th>{scored ? 'Quality' : 'Quality'}</th>
                  <th>Latency</th>
                  <th>TTFT</th>
                  <th>Throughput</th>
                  <th>n</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {ranked.map((t, i) => {
                  const open = openTarget === t.targetId;
                  return (
                    <tr key={t.targetId}>
                      <td>{i + 1}</td>
                      <td>
                        <strong>{t.label}</strong>
                        {t.caveat ? (
                          <div className="cmp-caveat" title={t.caveat}>
                            {t.caveat}
                          </div>
                        ) : null}
                      </td>
                      <td>{scored ? fmtPct(t.quality) : 'unscored'}</td>
                      <td>{fmtMs(t.meanLatencyMs)}</td>
                      <td>{fmtMs(t.meanTtftMs)}</td>
                      <td>{fmtTokS(t.tokensPerSec)}</td>
                      <td>{t.n}</td>
                      <td>
                        <button
                          type="button"
                          className="app-ghost-btn"
                          onClick={() => setOpenTarget(open ? null : t.targetId)}
                        >
                          {open ? 'Hide' : 'Answers'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {openTarget ? (
            <div className="cmp-answers">
              {(ranked.find((t) => t.targetId === openTarget)?.sampleResults ?? []).map(
                (s) => (
                  <article key={s.sampleId} className="cmp-answer">
                    <header>
                      <span className="cmp-answer-id">{s.sampleId}</span>
                      <span>{fmtMs(s.latencyMs)}</span>
                    </header>
                    <pre>{s.error ? `Error: ${s.error}` : s.prediction || '(empty)'}</pre>
                  </article>
                ),
              )}
            </div>
          ) : null}
        </section>
      ) : null}

      {result ? (
        <section className="cmp-card cmp-next">
          <div>
            <div className="pane-label">Next</div>
            <p className="field-hint">
              Run a blind preference tournament to get human win labels per prompt, then turn
              those labels into a routing policy.
            </p>
          </div>
          <button
            type="button"
            className="app-run-btn"
            disabled={!preferenceReady}
            title={
              preferenceReady
                ? undefined
                : 'Preference needs at least two models with answers.'
            }
            onClick={onStartPreference}
          >
            Start preference tournament
          </button>
        </section>
      ) : null}
    </div>
  );
}
