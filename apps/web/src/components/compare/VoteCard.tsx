'use client';

import { useT } from '@/components/LocaleProvider';
import type { Modality } from './types';

/**
 * One answer on a blind ballot. Model identity is deliberately absent: the
 * voter only sees a letter and the answer itself, so the vote measures the
 * output rather than the brand.
 */
export function VoteCard(props: {
  side: string;
  modality: Modality;
  answer: string;
  error?: string;
  onPick: () => void;
  disabled?: boolean;
  /** Reveal after the round resolves */
  revealedLabel?: string | null;
}) {
  const { side, modality, answer, error, onPick, disabled, revealedLabel } = props;
  const t = useT();

  return (
    <article className="vote-card">
      <header className="vote-card-head">
        <span className="vote-card-side">{side}</span>
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

      <button
        type="button"
        className="vote-card-pick"
        disabled={disabled}
        onClick={onPick}
      >
        {t('compare.vote.wins', { side })}
      </button>
    </article>
  );
}
