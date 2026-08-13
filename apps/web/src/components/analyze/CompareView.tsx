'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/components/LocaleProvider';
import { pct } from './format';
import { COMPARE_METRICS, type CompareResponse } from './types';

async function fetchCompare(runId: string, metric: string): Promise<CompareResponse> {
  const res = await fetch(
    `/api/analyze/runs/${encodeURIComponent(runId)}/compare?metric=${metric}`,
  );
  const json = (await res.json()) as CompareResponse & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

/** Is that difference real: rates with intervals, then the paired tests. */
export function CompareView(props: { runId: string }) {
  const t = useT();
  const [metric, setMetric] = useState<string>('toolSelect');
  const [data, setData] = useState<CompareResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const json = await fetchCompare(props.runId, metric);
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setData(null);
          setError(e instanceof Error ? e.message : 'Could not compare');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [metric, props.runId]);

  const separated = (data?.pairs ?? []).filter((p) => p.adjustedP < 0.05);

  return (
    <div className="az-compare">
      <section className="cmp-card">
        <div className="az-filters">
          <span className="pane-label">{t('analyze.compare.metric')}</span>
          {COMPARE_METRICS.map((m) => (
            <button
              key={m}
              type="button"
              className={`cmp-pref-mode${metric === m ? ' on' : ''}`}
              onClick={() => setMetric(m)}
            >
              {m}
            </button>
          ))}
        </div>
      </section>

      {error ? <div className="app-banner error">{error}</div> : null}
      {!data && !error ? <p className="field-hint">{t('analyze.loading')}</p> : null}

      {data ? (
        <>
          <section className="cmp-card">
            <div className="table-scroll">
              <table className="data-table text-xs">
                <thead>
                  <tr>
                    <th>{t('analyze.failures.col.model')}</th>
                    <th>{t('analyze.compare.rate')}</th>
                    <th>{t('analyze.compare.interval')}</th>
                    <th>n</th>
                  </tr>
                </thead>
                <tbody>
                  {[...data.rates]
                    .sort((a, b) => b.rate - a.rate)
                    .map((r) => (
                      <tr key={r.model}>
                        <td>{r.model}</td>
                        <td>
                          <strong>{pct(r.rate)}</strong>
                        </td>
                        <td>
                          {pct(r.interval.low)}–{pct(r.interval.high)}
                        </td>
                        <td>{r.n}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="cmp-card">
            <div className="table-scroll">
              <table className="data-table text-xs">
                <thead>
                  <tr>
                    <th>{t('analyze.compare.pair')}</th>
                    <th>{t('analyze.compare.difference')}</th>
                    <th>{t('analyze.compare.interval')}</th>
                    <th>{t('analyze.compare.disagreed')}</th>
                    <th>{t('analyze.compare.adjP')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.pairs.map((p, i) => {
                    const discordant = p.mcnemar.aOnly + p.mcnemar.bOnly;
                    const sig = p.adjustedP < 0.05;
                    return (
                      <tr key={i} className={sig ? 'is-current' : undefined}>
                        <td>
                          {p.a.model} vs {p.b.model}
                        </td>
                        <td>
                          {p.diff.value >= 0 ? '+' : ''}
                          {pct(p.diff.value)}
                        </td>
                        <td>
                          {pct(p.diff.interval.low)}–{pct(p.diff.interval.high)}
                        </td>
                        <td>{discordant}</td>
                        <td>
                          <strong>{p.adjustedP.toFixed(3)}</strong>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="field-hint">
              {separated.length > 0
                ? t('analyze.compare.separated', { count: separated.length })
                : t('analyze.compare.none')}
            </p>
            {data.pairs
              .filter((p) => p.warnings.length > 0)
              .map((p, i) => (
                <p key={i} className="field-hint az-warn">
                  ! {p.a.model} vs {p.b.model}: {p.warnings.join('; ')}
                </p>
              ))}
          </section>
        </>
      ) : null}
    </div>
  );
}
