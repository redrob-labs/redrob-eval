'use client';

import { useT } from '@/components/LocaleProvider';
import type { MessageKey } from '@/lib/i18n';
import { delta, rankEntries, type ArenaEntry, type ArenaStatus } from './model-arena';

function pct(v: number | null | undefined): string {
  return v == null ? '—' : `${(v * 100).toFixed(1)}%`;
}

const STATUS_KEYS: Record<ArenaStatus, MessageKey> = {
  queued: 'evolve.arena.status.queued',
  running: 'evolve.arena.status.running',
  done: 'evolve.arena.status.done',
  failed: 'evolve.arena.status.failed',
  stopped: 'evolve.arena.status.stopped',
};

/**
 * Which model to ship the evolved prompt on.
 *
 * Rows rather than a table: with a baseline, an evolved score, a delta, a test score,
 * tokens and one column per rubric dimension, a table needs a dozen columns and the
 * results pane is a third of the window. Everything below is legible at that width and
 * does not get wider when the pane does.
 *
 * Ranked by held-out test rather than by improvement — improvement ranks by how bad the
 * model started, and the model that gains most is routinely not the one to ship. The
 * evolved prompt sits under each row because the answer is a pair, this model with this
 * prompt, and showing the model alone invites someone to take the name and leave the
 * reason behind.
 */
export function ModelArena({ entries }: { entries: ArenaEntry[] }) {
  const t = useT();
  if (entries.length === 0) return null;

  const ranked = rankEntries(entries);
  const finished = ranked.filter((e) => e.status === 'done').length;

  return (
    <section className="arena">
      <div className="arena-head">
        <div className="pane-label">{t('evolve.arena.title')}</div>
        <span className="field-hint">
          {t('evolve.arena.finishedRatio', { finished, total: entries.length })}
        </span>
      </div>

      <ol className="arena-list">
        {ranked.map((e, i) => {
          const d = delta(e);
          const dims = Object.entries(e.dimensions ?? {});
          return (
            <li key={e.modelId} className={`arena-row is-${e.status}`}>
              <div className="arena-row-top">
                <span className="arena-rank">{e.status === 'done' ? i + 1 : '·'}</span>
                <span className="arena-name">
                  <strong>{e.label}</strong>
                  <code>{e.modelId}</code>
                </span>
                <span className="arena-test">
                  <strong>{pct(e.testQuality)}</strong>
                  <span>{t('evolve.arena.test')}</span>
                </span>
              </div>

              <div className="arena-row-stats">
                {/* Labelled `val`, because the big number beside it is test and two
                    unexplained percentages that disagree read as a bug rather than as
                    the difference between the split fitted to and the one held out. */}
                <span title={t('evolve.arena.valTitle')}>
                  {t('evolve.arena.valLabel', {
                    baseline: pct(e.baselineQuality),
                    evolved: pct(e.evolvedQuality),
                  })}
                </span>
                {d != null ? (
                  <span className={d > 0 ? 'delta-up' : d < 0 ? 'delta-down' : undefined}>
                    {d >= 0 ? '+' : ''}
                    {(d * 100).toFixed(1)} pts
                  </span>
                ) : null}
                {e.evolvedTokens != null ? (
                  <span>{t('evolve.arena.tokens', { count: e.evolvedTokens })}</span>
                ) : null}
                <span className={`arena-status is-${e.status}`}>
                  {t(STATUS_KEYS[e.status])}
                  {e.status === 'running' ? ` ${e.rollouts}/${e.maxRollouts}` : ''}
                </span>
              </div>

              {e.error ? <div className="arena-error">{e.error}</div> : null}

              {dims.length > 0 ? (
                <div className="arena-dims">
                  {dims.map(([name, value]) => (
                    <span key={name} title={`${name}, out of 10`}>
                      {name} <strong>{(value * 10).toFixed(1)}</strong>
                    </span>
                  ))}
                </div>
              ) : null}

              {e.instruction ? (
                <details className="arena-prompt">
                  <summary>{t('evolve.arena.promptItWonWith')}</summary>
                  <pre>{e.instruction}</pre>
                </details>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
