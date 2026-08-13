'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/components/LocaleProvider';
import { CompareView } from './CompareView';
import { FailuresView } from './FailuresView';
import { ago, duration, STATUS_MARK } from './format';
import type { RunDetailResponse } from './types';

type Tab = 'failures' | 'compare';

async function fetchRun(runId: string): Promise<RunDetailResponse> {
  const res = await fetch(`/api/analyze/runs/${encodeURIComponent(runId)}`);
  const json = (await res.json()) as RunDetailResponse & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

export function RunDetail(props: { runId: string; onBack: () => void }) {
  const t = useT();
  const [data, setData] = useState<RunDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('failures');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const json = await fetchRun(props.runId);
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load run');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.runId]);

  const run = data?.run;
  const hasArtifacts = (data?.artifacts.length ?? 0) > 0;

  return (
    <div className="az-detail-page">
      <div className="az-detail-top">
        <button type="button" className="app-ghost-btn" onClick={props.onBack}>
          {t('analyze.back')}
        </button>
      </div>

      {error ? <div className="app-banner error">{error}</div> : null}
      {!run ? (
        <p className="field-hint">{t('analyze.loading')}</p>
      ) : (
        <>
          <section className="cmp-card">
            <div className="pane-label">
              <span className={`az-status az-status-${run.status}`}>
                {STATUS_MARK[run.status] ?? run.status}
              </span>{' '}
              <code>{run.id}</code>
              {run.label ? <span className="az-run-label"> · {run.label}</span> : null}
            </div>
            <dl className="az-facts">
              <div>
                <dt>{t('analyze.runs.col.kind')}</dt>
                <dd>{run.kind}</dd>
              </div>
              <div>
                <dt>{t('analyze.runs.col.took')}</dt>
                <dd>
                  {duration(run.startedAt, run.finishedAt)} · {ago(run.createdAt)}
                </dd>
              </div>
              <div>
                <dt>{t('analyze.run.commit')}</dt>
                <dd>
                  <code>{run.provenance.gitSha?.slice(0, 10) ?? '—'}</code>
                  {run.provenance.gitDirty ? ` (${t('analyze.run.dirty')})` : ''}
                </dd>
              </div>
              <div>
                <dt>{t('analyze.run.paramsHash')}</dt>
                <dd>
                  <code>{run.provenance.paramsHash}</code>
                </dd>
              </div>
              {run.provenance.models.length ? (
                <div>
                  <dt>{t('analyze.run.models')}</dt>
                  <dd>{run.provenance.models.join(', ')}</dd>
                </div>
              ) : null}
              {run.provenance.datasetId ? (
                <div>
                  <dt>dataset</dt>
                  <dd>{run.provenance.datasetId}</dd>
                </div>
              ) : null}
            </dl>
            {run.error ? <div className="app-banner error">{run.error}</div> : null}
            {run.summary != null ? (
              <pre className="az-pre az-summary">{JSON.stringify(run.summary, null, 2)}</pre>
            ) : null}
          </section>

          {hasArtifacts ? (
            <>
              <nav className="az-tabs">
                <button
                  type="button"
                  className={`az-tab${tab === 'failures' ? ' on' : ''}`}
                  onClick={() => setTab('failures')}
                >
                  {t('analyze.tab.failures')}
                </button>
                <button
                  type="button"
                  className={`az-tab${tab === 'compare' ? ' on' : ''}`}
                  onClick={() => setTab('compare')}
                >
                  {t('analyze.tab.compare')}
                </button>
              </nav>
              {tab === 'failures' ? (
                <FailuresView runId={props.runId} />
              ) : (
                <CompareView runId={props.runId} />
              )}
            </>
          ) : (
            <section className="cmp-card">
              <div className="pane-label">{t('analyze.run.events')}</div>
              <div className="table-scroll">
                <table className="data-table text-xs">
                  <tbody>
                    {(data?.events ?? []).map((e) => (
                      <tr key={e.seq}>
                        <td>{e.seq}</td>
                        <td>{e.level}</td>
                        <td>{e.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
