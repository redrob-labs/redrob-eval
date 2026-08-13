'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '@/components/LocaleProvider';
import type { Failure, FailuresResponse } from './types';
import { RECOVERABLE } from './types';

async function fetchFailures(runId: string): Promise<FailuresResponse> {
  const res = await fetch(`/api/analyze/runs/${encodeURIComponent(runId)}/failures`);
  const json = (await res.json()) as FailuresResponse & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

const KINDS = [
  'format',
  'envelope',
  'wrong_tool',
  'bad_arguments',
  'missed_abstention',
  'wrong_abstention',
  'spurious_call',
  'instruction_dropped',
  'context_lost',
  'correction_ignored',
  'desynced',
  'call_error',
  'other',
];

/**
 * Triage: what kind of wrong, the request and reply side by side, and the two
 * things a session should leave behind - a re-runnable cohort and a correction.
 */
export function FailuresView(props: { runId: string }) {
  const t = useT();
  const [data, setData] = useState<FailuresResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState('');
  const [model, setModel] = useState('');
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Bumped to force a re-fetch after a correction, without a setState-in-effect.
  const [reloadAt, setReloadAt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const json = await fetchFailures(props.runId);
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load failures');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.runId, reloadAt]);

  const reload = useCallback(() => setReloadAt((n) => n + 1), []);

  const filtered = useMemo(() => {
    const all = data?.failures ?? [];
    const needle = search.trim().toLowerCase();
    return all.filter((f) => {
      if (kind && f.kind !== kind) return false;
      if (model && f.model !== model) return false;
      if (needle) {
        const hay = `${f.item} ${f.detail} ${f.actual ?? ''}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [data, kind, model, search]);

  const recoverable = useMemo(
    () => filtered.filter((f) => RECOVERABLE.has(f.kind)).length,
    [filtered],
  );

  const open = filtered.find((f) => f.id === openId) ?? null;

  const saveCohort = useCallback(async () => {
    const name = window.prompt(t('analyze.failures.cohortName'));
    if (!name) return;
    try {
      const res = await fetch(`/api/analyze/runs/${encodeURIComponent(props.runId)}/cohort`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          failureIds: filtered.map((f) => f.id),
          filter: { ...(kind ? { kind } : {}), ...(model ? { model } : {}) },
        }),
      });
      const json = (await res.json()) as { cohort?: { id: string; members: unknown[] }; error?: string };
      if (!res.ok || !json.cohort) throw new Error(json.error ?? `HTTP ${res.status}`);
      setNotice(
        t('analyze.failures.cohortSaved', {
          id: json.cohort.id,
          count: json.cohort.members.length,
        }),
      );
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not save cohort');
    }
  }, [filtered, kind, model, props.runId, t]);

  if (error) return <div className="app-banner error">{error}</div>;
  if (!data) return <p className="field-hint">{t('analyze.loading')}</p>;
  if (data.failures.length === 0) {
    return <p className="field-hint">{t('analyze.failures.none')}</p>;
  }

  return (
    <div className="az-failures">
      <section className="cmp-card">
        <div className="az-tally">
          {data.tally.map((row) => (
            <button
              key={row.kind}
              type="button"
              className={`az-chip${kind === row.kind ? ' on' : ''}${
                RECOVERABLE.has(row.kind) ? ' az-chip-recoverable' : ''
              }`}
              onClick={() => setKind(kind === row.kind ? '' : row.kind)}
            >
              {row.kind} <span className="az-chip-n">{row.count}</span>
            </button>
          ))}
        </div>
        <p className="field-hint">
          {t('analyze.failures.count', { count: filtered.length })}
          {recoverable > 0 ? ` · ${t('analyze.failures.recoverable', { count: recoverable })}` : ''}
        </p>
        <div className="az-filters">
          <input
            className="az-input"
            placeholder="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">{t('analyze.failures.allModels')}</option>
            {data.facets.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="app-ghost-btn"
            disabled={filtered.length === 0}
            onClick={() => void saveCohort()}
          >
            {t('analyze.failures.saveCohort', { count: filtered.length })}
          </button>
        </div>
        {notice ? <div className="app-banner">{notice}</div> : null}
      </section>

      {open ? (
        <FailureDetail
          runId={props.runId}
          failure={open}
          onClose={() => setOpenId(null)}
          onAnnotated={reload}
        />
      ) : null}

      <section className="cmp-card">
        <div className="table-scroll">
          <table className="data-table text-xs">
            <thead>
              <tr>
                <th>{t('analyze.failures.col.kind')}</th>
                <th>{t('analyze.failures.col.item')}</th>
                <th>{t('analyze.failures.col.model')}</th>
                <th>{t('analyze.failures.col.detail')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((f) => (
                <tr
                  key={f.id}
                  className={`az-fail-row${openId === f.id ? ' is-current' : ''}`}
                  onClick={() => setOpenId(f.id)}
                >
                  <td>
                    <span className={`az-kind az-kind-${f.kind}`}>{f.kind}</span>
                    {f.annotated ? <span className="az-annot">*</span> : null}
                  </td>
                  <td>
                    {f.item}
                    {f.language ? <span className="az-lang">{f.language}</span> : null}
                    {f.turn ? <span className="az-lang">#{f.turn}</span> : null}
                  </td>
                  <td>{f.model}</td>
                  <td className="az-detail-cell">{f.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

/** The side by side: what was asked, what was expected, what came back. */
function FailureDetail(props: {
  runId: string;
  failure: Failure;
  onClose: () => void;
  onAnnotated: () => void;
}) {
  const t = useT();
  const { failure } = props;
  const [reclassify, setReclassify] = useState(false);
  const [asKind, setAsKind] = useState(failure.kind);
  const [note, setNote] = useState(failure.note ?? '');
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLElement | null>(null);

  // The panel opens above a long table, so pull it into view on open and when
  // the selection changes: the whole point is that a click shows the evidence,
  // not that you scroll to find it.
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [failure.id]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/analyze/runs/${encodeURIComponent(props.runId)}/annotate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ failureId: failure.id, kind: asKind, note: note.trim() || undefined }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setReclassify(false);
      props.onAnnotated();
    } finally {
      setSaving(false);
    }
  }, [asKind, failure.id, note, props]);

  return (
    <section className="cmp-card az-detail" ref={ref}>
      <div className="cmp-run-head">
        <div className="pane-label">
          <span className={`az-kind az-kind-${failure.kind}`}>{failure.kind}</span>
          {failure.derivedKind ? (
            <span className="az-was">{t('analyze.failures.was', { kind: failure.derivedKind })}</span>
          ) : null}
          {'  '}
          {failure.model} · {failure.item}
          {failure.language ? ` (${failure.language})` : ''}
        </div>
        <button type="button" className="app-ghost-btn" onClick={props.onClose}>
          {t('analyze.detail.close')}
        </button>
      </div>

      {failure.note ? (
        <p className="field-hint">
          {t('analyze.detail.note')}: {failure.note}
        </p>
      ) : null}
      <div className="az-kv">
        <span className="az-kv-key">{t('analyze.detail.why')}</span>
        <span>{failure.detail}</span>
      </div>
      {failure.expected ? (
        <div className="az-kv">
          <span className="az-kv-key">{t('analyze.detail.expected')}</span>
          <pre className="az-pre">{failure.expected}</pre>
        </div>
      ) : null}
      {failure.prompt ? (
        <div className="az-kv">
          <span className="az-kv-key">{t('analyze.detail.asked')}</span>
          <pre className="az-pre">{failure.prompt}</pre>
        </div>
      ) : null}
      <div className="az-kv">
        <span className="az-kv-key">{t('analyze.detail.got')}</span>
        <pre className="az-pre az-pre-got">{failure.actual ?? ''}</pre>
      </div>

      {reclassify ? (
        <div className="az-reclassify">
          <select value={asKind} onChange={(e) => setAsKind(e.target.value)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <input
            className="az-input"
            placeholder={t('analyze.detail.notePlaceholder')}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button type="button" className="app-run-btn" disabled={saving} onClick={() => void save()}>
            {t('analyze.detail.saveVerdict')}
          </button>
        </div>
      ) : (
        <div className="cmp-actions">
          <button type="button" className="app-ghost-btn" onClick={() => setReclassify(true)}>
            {t('analyze.detail.reclassify')}
          </button>
        </div>
      )}
    </section>
  );
}
