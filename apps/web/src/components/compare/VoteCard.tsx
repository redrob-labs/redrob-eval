'use client';

import { useT } from '@/components/LocaleProvider';
import type { Modality } from './types';

/**
 * One answer on a blind ballot. Model identity is deliberately absent while the
 * ballot is open: the voter only sees a letter and the answer itself, so the
 * vote measures the output rather than the brand. `revealedLabel` is for after
 * the prompt is decided, where hiding it no longer protects anything.
 */
export function VoteCard(props: {
  side: string;
  modality: Modality;
  answer: string;
  error?: string;
  onPick?: () => void;
  disabled?: boolean;
  /** Overrides the default "{side} wins" on the primary button. */
  pickLabel?: string;
  /** A second way to vote on this answer, such as knocking it out. */
  secondary?: { label: string; onClick: () => void } | null;
  /** Place shown on the card, e.g. the position picked so far in a ranking. */
  badge?: string | null;
  /** Knocked-out answers stay on screen, dimmed, so the ballot still reads. */
  eliminated?: boolean;
  /** Reveal after the prompt resolves */
  revealedLabel?: string | null;
}) {
  const {
    side,
    modality,
    answer,
    error,
    onPick,
    disabled,
    pickLabel,
    secondary,
    badge,
    eliminated,
    revealedLabel,
  } = props;
  const t = useT();

  return (
    <article className={`vote-card${eliminated ? ' is-out' : ''}`}>
      <header className="vote-card-head">
        <span className="vote-card-side">{side}</span>
        {badge ? <span className="vote-card-badge">{badge}</span> : null}
        {revealedLabel ? <span className="vote-card-reveal">{revealedLabel}</span> : null}
      </header>

      <div className="vote-card-body">
        {error ? (
          <p className="vote-card-error">{t('compare.vote.failed', { error })}</p>
        ) : modality === 'image' ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="vote-card-image" src={answer} alt={t('compare.vote.answerAlt', { side })} />
        ) : (
          <pre className="vote-card-text">{answer || t('compare.vote.emptyAnswer')}</pre>
        )}
      </div>

      {onPick || secondary ? (
        <div className="vote-card-actions">
          {onPick ? (
            <button
              type="button"
              className="vote-card-pick"
              disabled={disabled}
              onClick={onPick}
            >
              {pickLabel ?? t('compare.vote.wins', { side })}
            </button>
          ) : null}
          {secondary ? (
            <button
              type="button"
              className="vote-card-out"
              disabled={disabled}
              onClick={secondary.onClick}
            >
              {secondary.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
