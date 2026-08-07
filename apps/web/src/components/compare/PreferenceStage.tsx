'use client';

import { useCallback, useState } from 'react';
import { VoteCard } from './VoteCard';
import type { Bracket, Modality, TournamentState, VoteWinner } from './types';

function pendingMatch(bracket: Bracket) {
  for (const round of bracket.rounds) {
    for (const match of round) {
      if (!match.winnerModelId && match.a && match.b) return match;
    }
  }
  return null;
}

/** First unresolved match across all prompt brackets, in prompt order. */
function firstPending(state: TournamentState | null) {
  if (!state) return null;
  for (const bracket of state.brackets) {
    const match = pendingMatch(bracket);
    if (match) return { bracket, match };
  }
  return null;
}

function competitor(bracket: Bracket, modelId: string) {
  return bracket.competitors.find((c) => c.modelId === modelId) ?? null;
}

export function PreferenceStage(props: {
  modality: Modality;
  state: TournamentState | null;
  starting: boolean;
  error: string | null;
  onStart: () => void;
  onVote: (promptId: string, matchId: string, winner: VoteWinner) => Promise<void>;
  /** Undefined when this modality has no model judge. */
  onJudge?: (promptId: string, matchId: string) => Promise<void>;
  onOptimizeRoute: () => void;
}) {
  const { modality, state, starting, error, onStart, onVote, onJudge, onOptimizeRoute } =
    props;
  const [voting, setVoting] = useState(false);

  const current = firstPending(state);

  const vote = useCallback(
    async (winner: VoteWinner) => {
      if (!current || voting) return;
      setVoting(true);
      try {
        await onVote(current.bracket.promptId, current.match.matchId, winner);
      } finally {
        setVoting(false);
      }
    },
    [current, onVote, voting],
  );

  const judge = useCallback(async () => {
    if (!current || voting || !onJudge) return;
    setVoting(true);
    try {
      await onJudge(current.bracket.promptId, current.match.matchId);
    } finally {
      setVoting(false);
    }
  }, [current, onJudge, voting]);

  if (!state) {
    return (
      <section className="cmp-card">
        <div className="pane-label">Blind preference tournament</div>
        <p className="field-hint">
          Every prompt gets its own single-elimination bracket. You see two answers
          at a time with the model names hidden, pick the better one, and the winner
          advances until one answer takes the prompt. Those per-prompt winners become
          the routing labels in the next stage.
        </p>
        {error ? <div className="app-banner error">{error}</div> : null}
        <div className="cmp-actions">
          <button
            type="button"
            className="app-run-btn"
            disabled={starting}
            onClick={onStart}
          >
            {starting ? 'Building brackets…' : 'Build brackets'}
          </button>
        </div>
      </section>
    );
  }

  const { aggregate } = state;
  const done = aggregate.matchesTotal > 0 && aggregate.matchesVoted >= aggregate.matchesTotal;

  return (
    <div className="cmp-pref">
      <section className="cmp-card">
        <div className="cmp-run-head">
          <div>
            <div className="pane-label">Blind preference tournament</div>
            <p className="field-hint">
              {aggregate.matchesVoted} / {aggregate.matchesTotal} matches decided
              {current ? ` · prompt ${current.bracket.promptId}, round ${current.match.round + 1}` : ''}
            </p>
          </div>
        </div>
        {error ? <div className="app-banner error">{error}</div> : null}
      </section>

      {current ? (
        <section className="cmp-card">
          <div className="pane-label">Prompt</div>
          <pre className="cmp-prompt-text">{current.bracket.promptText}</pre>

          <div className="vote-grid">
            <VoteCard
              side="A"
              modality={modality}
              answer={competitor(current.bracket, current.match.a!)?.answer ?? ''}
              error={competitor(current.bracket, current.match.a!)?.error}
              disabled={voting}
              onPick={() => void vote('a')}
            />
            <VoteCard
              side="B"
              modality={modality}
              answer={competitor(current.bracket, current.match.b!)?.answer ?? ''}
              error={competitor(current.bracket, current.match.b!)?.error}
              disabled={voting}
              onPick={() => void vote('b')}
            />
          </div>

          <div className="cmp-actions">
            <button
              type="button"
              className="app-ghost-btn"
              disabled={voting}
              onClick={() => void vote('tie')}
            >
              Too close to call
            </button>
            {onJudge ? (
              <button
                type="button"
                className="app-ghost-btn"
                disabled={voting}
                title="Hand this match to a model judge; you still vote the rest."
                onClick={() => void judge()}
              >
                Let the judge decide
              </button>
            ) : null}
          </div>
        </section>
      ) : (
        <section className="cmp-card">
          <div className="pane-label">All matches decided</div>
          <p className="field-hint">
            {aggregate.overallChampionModelId
              ? `${
                  aggregate.standings.find(
                    (s) => s.modelId === aggregate.overallChampionModelId,
                  )?.label ?? aggregate.overallChampionModelId
                } won the most prompts.`
              : 'No clear champion — the prompts split between models.'}
          </p>
        </section>
      )}

      <section className="cmp-card">
        <div className="pane-label">Standings</div>
        <div className="table-scroll">
          <table className="data-table text-xs">
            <thead>
              <tr>
                <th>#</th>
                <th>Model</th>
                <th>Prompts won</th>
                <th>W</th>
                <th>L</th>
                <th>T</th>
                <th>Win rate</th>
              </tr>
            </thead>
            <tbody>
              {aggregate.standings.map((s, i) => (
                <tr key={s.modelId}>
                  <td>{i + 1}</td>
                  <td>
                    <strong>{s.label}</strong>
                  </td>
                  <td>{s.championOf}</td>
                  <td>{s.wins}</td>
                  <td>{s.losses}</td>
                  <td>{s.ties}</td>
                  <td>{(s.winRate * 100).toFixed(0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="cmp-card cmp-next">
        <div>
          <div className="pane-label">Next</div>
          <p className="field-hint">
            Turn these per-prompt winners into routing labels: pick a fast model and
            see how often it can carry the traffic without losing the vote.
          </p>
        </div>
        <button
          type="button"
          className="app-run-btn"
          disabled={!done}
          title={done ? undefined : 'Finish every match first.'}
          onClick={onOptimizeRoute}
        >
          Optimize route
        </button>
      </section>
    </div>
  );
}
