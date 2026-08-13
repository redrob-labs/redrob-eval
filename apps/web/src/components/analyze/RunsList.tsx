'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/components/LocaleProvider';
import { ago, duration, STATUS_MARK } from './format';
import type { RunsResponse } from './types';

const STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'];

async function fetchRuns(params: {
  kind: string;
  status: string;
  search: string;
}): Promise<RunsResponse> {
  const q = new URLSearchParams();
  if (params.kind) q.set('kind', params.kind);
  if (params.status) q.set('status', params.status);
  if (params.search.trim()) q.set('search', params.search.trim());
  const res = await fetch(`/api/analyze/runs?${q.toString()}`);
  const json = (await res.json()) as RunsResponse & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

/** The registry as a browsable table: what was run, of what kind, in what state. */
export function RunsList(props: { onOpen: (runId: string) => void }) {
  const t = useT();
  const [data, setData] = useState<RunsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');

  // A running matrix should visibly finish without a manual refresh, so the
  // list both loads on filter change and polls. setState lives inside the async
  // callbacks, never synchronously in the effect body.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const json = await fetchRuns({ kind, status, search });
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load runs');
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [kind, status, search]);

  const runs = data?.runs ?? [];

  return (
    <section className="cmp-card az-runs">
      <div className="cmp-run-head">
        <div className="pane-label">{t('analyze.runs.title')}</div>
        <div className="az-filters">
          <input
            className="az-input"
            placeholder={t('analyze.runs.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">{t('analyze.runs.allKinds')}</option>
            {(data?.kinds ?? []).map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{t('analyze.runs.allStatuses')}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error ? <div className="app-banner error">{error}</div> : null}

      {runs.length === 0 ? (
        <p className="field-hint">{t('analyze.runs.empty')}</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table text-xs az-runs-table">
            <thead>
              <tr>
                <th>{t('analyze.runs.col.status')}</th>
                <th>{t('analyze.runs.col.id')}</th>
                <th>{t('analyze.runs.col.kind')}</th>
                <th>{t('analyze.runs.col.took')}</th>
                <th>{t('analyze.runs.col.when')}</th>
                <th>{t('analyze.runs.col.label')}</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="az-run-row" onClick={() => props.onOpen(run.id)}>
                  <td>
                    <span className={`az-status az-status-${run.status}`}>
                      {STATUS_MARK[run.status] ?? run.status}
                    </span>
                  </td>
                  <td>
                    <code>{run.id}</code>
                  </td>
                  <td>{run.kind}</td>
                  <td>{duration(run.startedAt, run.finishedAt)}</td>
                  <td>{ago(run.createdAt)}</td>
                  <td>{run.label ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data ? (
        <p className="field-hint">
          {t('analyze.runs.count', {
            shown: runs.length,
            total: data.total,
            driver: data.driver,
          })}
        </p>
      ) : null}
    </section>
  );
}
