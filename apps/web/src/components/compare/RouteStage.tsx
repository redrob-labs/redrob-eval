'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from '@/components/LocaleProvider';
import type { RoutePolicyResult, TournamentState } from './types';

function pct(v: number): string {
  return `${(v * 100).toFixed(0)}%`;
}

/**
 * Preference votes become a routing policy: the user names a fast candidate and
 * a fallback, and each prompt the fast one won or tied becomes a `small` label.
 * Saving writes those labels into the same routing corpus the metric-derived
 * collector fills, so training and export are unchanged.
 */
export function RouteStage(props: {
  state: TournamentState | null;
  onDerive: (
    smallModelId: string,
    largeModelId: string,
    save: boolean,
  ) => Promise<RoutePolicyResult | null>;
  onBack: () => void;
}) {
  const { state, onDerive, onBack } = props;
  const t = useT();
  const [smallId, setSmallId] = useState('');
  const [largeId, setLargeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [policy, setPolicy] = useState<RoutePolicyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const models = useMemo(() => {
    if (!state) return [] as Array<{ id: string; label: string }>;
    const seen = new Map<string, string>();
    for (const b of state.brackets) {
      for (const c of b.competitors) if (!seen.has(c.modelId)) seen.set(c.modelId, c.label);
    }
    return Array.from(seen, ([id, label]) => ({ id, label }));
  }, [state]);

  /** Seed the picks from the standings: slowest-to-win becomes the fallback. */
  useEffect(() => {
    if (!state || smallId || largeId || models.length < 2) return;
    const frame = requestAnimationFrame(() => {
      const ranked = state.aggregate.standings;
      const champion = ranked[0]?.modelId ?? models[0]!.id;
      const challenger = models.find((m) => m.id !== champion)?.id ?? models[1]!.id;
      setSmallId(challenger);
      setLargeId(champion);
    });
    return () => cancelAnimationFrame(frame);
  }, [state, models, smallId, largeId]);

  const derive = useCallback(
    async (save: boolean) => {
      if (!smallId || !largeId || busy) return;
      setBusy(true);
      setError(null);
      try {
        const next = await onDerive(smallId, largeId, save);
        if (next) setPolicy(next);
      } catch (e) {
        setError(e instanceof Error ? e.message : t('compare.route.couldNotDerive'));
      } finally {
        setBusy(false);
      }
    },
    [smallId, largeId, busy, onDerive, t],
  );

  if (!state) {
    return (
      <section className="cmp-card">
        <div className="pane-label">{t('compare.route.title')}</div>
        <p className="field-hint">{t('compare.route.finishFirst')}</p>
        <div className="cmp-actions">
          <button type="button" className="app-ghost-btn" onClick={onBack}>
            {t('compare.route.backToPreference')}
          </button>
        </div>
      </section>
    );
  }

  const summary = policy?.summary;

  return (
    <div className="cmp-route">
      <section className="cmp-card">
        <div className="pane-label">{t('compare.route.title')}</div>
        <p className="field-hint">{t('compare.route.explainer')}</p>

        <div className="cmp-route-picks">
          <label className="field">
            <span>{t('compare.route.fastModel')}</span>
            <select value={smallId} onChange={(e) => setSmallId(e.target.value)}>
              <option value="">{t('compare.route.selectPlaceholder')}</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t('compare.route.fallback')}</span>
            <select value={largeId} onChange={(e) => setLargeId(e.target.value)}>
              <option value="">{t('compare.route.selectPlaceholder')}</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {error ? <div className="app-banner error">{error}</div> : null}

        <div className="cmp-actions">
          <button
            type="button"
            className="app-run-btn"
            disabled={busy || !smallId || !largeId || smallId === largeId}
            onClick={() => void derive(false)}
          >
            {busy ? t('common.working') : t('compare.route.previewPolicy')}
          </button>
          <button
            type="button"
            className="app-ghost-btn"
            disabled={busy || !policy}
            title={t('compare.route.saveToCorpusTitle')}
            onClick={() => void derive(true)}
          >
            {t('compare.route.saveToCorpus')}
          </button>
          <button type="button" className="app-ghost-btn" onClick={onBack}>
            {t('compare.route.backToPreference')}
          </button>
        </div>
      </section>

      {summary ? (
        <section className="cmp-card">
          <div className="cmp-run-head">
            <div>
              <div className="pane-label">{t('compare.route.policy')}</div>
              <p className="field-hint">
                {policy?.saved
                  ? t('compare.route.savedAs', { runId: policy.routingRunId })
                  : t('compare.route.previewOnly')}
                {policy?.skipped
                  ? ` ${t('compare.route.skippedNote', { count: policy.skipped })}`
                  : ''}
              </p>
            </div>
          </div>

          <dl className="cmp-route-stats">
            <div>
              <dt>{t('compare.route.saveRate')}</dt>
              <dd>{pct(summary.saveRate)}</dd>
              <span>{t('compare.route.saveRateHint')}</span>
            </div>
            <div>
              <dt>{t('compare.route.labeled')}</dt>
              <dd>
                {t('compare.route.labeledSummary', {
                  small: summary.meta.labelSmall,
                  large: summary.meta.labelLarge,
                })}
              </dd>
              <span>{t('compare.route.labeledCount', { count: summary.meta.sampleCount })}</span>
            </div>
            <div>
              <dt>{t('compare.route.heuristicAgreement')}</dt>
              <dd>{pct(summary.heuristicAgreeWithOracle)}</dd>
              <span>{t('compare.route.heuristicHint')}</span>
            </div>
            <div>
              <dt>{t('compare.route.wonAlone')}</dt>
              <dd>
                {pct(summary.smallAloneQuality)} / {pct(summary.largeAloneQuality)}
              </dd>
              <span>{t('compare.route.wonAloneHint')}</span>
            </div>
          </dl>
        </section>
      ) : null}

      {policy?.examples.length ? (
        <section className="cmp-card">
          <div className="pane-label">{t('compare.route.labels')}</div>
          <div className="table-scroll">
            <table className="data-table text-xs">
              <thead>
                <tr>
                  <th>{t('compare.route.table.prompt')}</th>
                  <th>{t('compare.route.table.route')}</th>
                  <th>{t('compare.route.table.why')}</th>
                </tr>
              </thead>
              <tbody>
                {policy.examples.map((e) => (
                  <tr key={e.sampleId}>
                    <td title={e.input}>
                      {e.input.length > 90 ? `${e.input.slice(0, 87)}…` : e.input}
                    </td>
                    <td>
                      <strong>{e.label}</strong>
                    </td>
                    <td>{e.labelReason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
