'use client';

import type { Modality } from './types';

/**
 * One side of a blind match. Model identity is deliberately absent — the voter
 * only sees "A" or "B" and the answer itself, so the vote measures the output
 * rather than the brand.
 */
export function VoteCard(props: {
  side: 'A' | 'B';
  modality: Modality;
  answer: string;
  error?: string;
  onPick: () => void;
  disabled?: boolean;
  /** Reveal after the round resolves */
  revealedLabel?: string | null;
}) {
  const { side, modality, answer, error, onPick, disabled, revealedLabel } = props;

  return (
    <article className="vote-card">
      <header className="vote-card-head">
        <span className="vote-card-side">{side}</span>
        {revealedLabel ? <span className="vote-card-reveal">{revealedLabel}</span> : null}
      </header>

      <div className="vote-card-body">
        {error ? (
          <p className="vote-card-error">Failed: {error}</p>
        ) : modality === 'image' ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="vote-card-image" src={answer} alt={`Answer ${side}`} />
        ) : (
          <pre className="vote-card-text">{answer || '(empty answer)'}</pre>
        )}
      </div>

      <button
        type="button"
        className="vote-card-pick"
        disabled={disabled}
        onClick={onPick}
      >
        {side} wins
      </button>
    </article>
  );
}
