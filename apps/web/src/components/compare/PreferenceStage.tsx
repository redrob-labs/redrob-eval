'use client';

import { useCallback, useState } from 'react';
import { useT } from '@/components/LocaleProvider';
import { VoteCard } from './VoteCard';
import type { Bracket, Modality, TournamentState, VoteWinner } from './types';

/** Letters shown in place of model names, so the ballot stays blind. */
const SIDES = 'ABCDEFGH';

function pendingMatch(bracket: Bracket) {
  for (const round of bracket.rounds) {
    for (const match of round) {
      if (!match.winnerModelId && match.a && match.b) return match;
    }
  }
  return null;
}

/**
 * The next thing waiting on a vote, across all prompt brackets in prompt order.
 * A small field is one group ballot; a large one is the next pair.
 */
function firstPending(state: TournamentState | null) {
  if (!state) return null;
  for (const bracket of state.brackets) {
    const group = bracket.group;
    if (group) {
      if (!group.winnerModelId && !group.tie && group.contenders.length > 1) {
        return { bracket, group, match: null };
      }
      continue;
    }
    const match = pendingMatch(bracket);
    if (match) return { bracket, group: null, match };
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
  /** One decision over a whole ballot. Null wins means the voter called it a tie. */
  onGroupVote: (
    promptId: string,
    matchId: string,
    winnerModelId: string | null,
  ) => Promise<void>;
  /** Undefined when this modality has no model judge. */
  onJudge?: (promptId: string, matchId: string) => Promise<void>;
  /** What the task puts on the ballot, when that needs saying. */
  hint?: string;
  onOptimizeRoute: () => void;
}) {
  const {
    modality,
    state,
    starting,
    error,
    onStart,
    onVote,
    onGroupVote,
    onJudge,
    hint,
    onOptimizeRoute,
  } = props;
  const t = useT();
  const [voting, setVoting] = useState(false);

  const current = firstPending(state);

  const vote = useCallback(
    async (winner: VoteWinner) => {
      if (!current?.match || voting) return;
      setVoting(true);
      try {
        await onVote(current.bracket.promptId, current.match.matchId, winner);
      } finally {
        setVoting(false);
      }
    },
    [current, onVote, voting],
  );

  const voteGroup = useCallback(
    async (winnerModelId: string | null) => {
      if (!current?.group || voting) return;
      setVoting(true);
      try {
        await onGroupVote(current.bracket.promptId, current.group.matchId, winnerModelId);
      } finally {
        setVoting(false);
      }
    },
    [current, onGroupVote, voting],
  );

  const judge = useCallback(async () => {
    if (!current || voting || !onJudge) return;
    const matchId = current.group?.matchId ?? current.match?.matchId;
    if (!matchId) return;
    setVoting(true);
    try {
      await onJudge(current.bracket.promptId, matchId);
    } finally {
      setVoting(false);
    }
  }, [current, onJudge, voting]);

  if (!state) {
    return (
      <section className="cmp-card">
        <div className="pane-label">{t('compare.pref.title')}</div>
        <p className="field-hint">{t('compare.pref.explainer')}</p>
        {hint ? <p className="field-hint">{hint}</p> : null}
        {error ? <div className="app-banner error">{error}</div> : null}
        <div className="cmp-actions">
          <button
            type="button"
            className="app-run-btn"
            disabled={starting}
            onClick={onStart}
          >
            {starting ? t('compare.pref.buildingBrackets') : t('compare.pref.buildBrackets')}
          </button>
        </div>
      </section>
    );
  }

  const { aggregate } = state;
  const done = aggregate.matchesTotal > 0 && aggregate.matchesVoted >= aggregate.matchesTotal;

  // A prompt where every rival errored is awarded to the one answer that exists.
  // Say so, otherwise the standings look like they moved on their own.
  const walkovers = state.brackets.filter(
    (b) => b.championModelId && b.competitors.filter((c) => !c.error).length <= 1,
  ).length;

  return (
    <div className="cmp-pref">
      <section className="cmp-card">
        <div className="cmp-run-head">
          <div>
            <div className="pane-label">{t('compare.pref.title')}</div>
            <p className="field-hint">
              {t('compare.pref.matchesDecided', {
                voted: aggregate.matchesVoted,
                total: aggregate.matchesTotal,
              })}
              {current
                ? current.group
                  ? t('compare.pref.promptGroup', {
                      promptId: current.bracket.promptId,
                      count: current.group.contenders.length,
                    })
                  : t('compare.pref.promptRound', {
                      promptId: current.bracket.promptId,
                      round: current.match!.round + 1,
                    })
                : ''}
            </p>
          </div>
        </div>
        {error ? <div className="app-banner error">{error}</div> : null}
      </section>

      {current ? (
        <section className="cmp-card">
          <div className="pane-label">{t('compare.pref.prompt')}</div>
          <pre className="cmp-prompt-text">{current.bracket.promptText}</pre>

          <div className={`vote-grid${current.group ? ' is-group' : ''}`}>
            {current.group
              ? current.group.contenders.map((modelId, i) => (
                  <VoteCard
                    key={modelId}
                    side={SIDES[i] ?? String(i + 1)}
                    modality={modality}
                    answer={competitor(current.bracket, modelId)?.answer ?? ''}
                    error={competitor(current.bracket, modelId)?.error}
                    disabled={voting}
                    onPick={() => void voteGroup(modelId)}
                  />
                ))
              : (['a', 'b'] as const).map((side, i) => {
                  const modelId = side === 'a' ? current.match!.a! : current.match!.b!;
                  return (
                    <VoteCard
                      key={side}
                      side={SIDES[i]!}
                      modality={modality}
                      answer={competitor(current.bracket, modelId)?.answer ?? ''}
                      error={competitor(current.bracket, modelId)?.error}
                      disabled={voting}
                      onPick={() => void vote(side)}
                    />
                  );
                })}
          </div>

          <div className="cmp-actions">
            <button
              type="button"
              className="app-ghost-btn"
              disabled={voting}
              onClick={() => (current.group ? void voteGroup(null) : void vote('tie'))}
            >
              {t('compare.pref.tooCloseToCall')}
            </button>
            {onJudge ? (
              <button
                type="button"
                className="app-ghost-btn"
                disabled={voting}
                title={t('compare.pref.judgeTitle')}
                onClick={() => void judge()}
              >
                {t('compare.pref.letJudgeDecide')}
              </button>
            ) : null}
          </div>
        </section>
      ) : (
        <section className="cmp-card">
          <div className="pane-label">{t('compare.pref.allDecided')}</div>
          <p className="field-hint">
            {aggregate.overallChampionModelId
              ? t('compare.pref.championWon', {
                  label:
                    aggregate.standings.find(
                      (s) => s.modelId === aggregate.overallChampionModelId,
                    )?.label ?? aggregate.overallChampionModelId,
                })
              : t('compare.pref.noChampion')}
          </p>
        </section>
      )}

      <section className="cmp-card">
        <div className="pane-label">{t('compare.pref.standings')}</div>
        {walkovers > 0 ? (
          <p className="field-hint">{t('compare.pref.walkovers', { count: walkovers })}</p>
        ) : null}
        <div className="table-scroll">
          <table className="data-table text-xs">
            <thead>
              <tr>
                <th>{t('compare.pref.table.rank')}</th>
                <th>{t('compare.pref.table.model')}</th>
                <th>{t('compare.pref.table.promptsWon')}</th>
                <th>{t('compare.pref.table.w')}</th>
                <th>{t('compare.pref.table.l')}</th>
                <th>{t('compare.pref.table.t')}</th>
                <th>{t('compare.pref.table.winRate')}</th>
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
          <div className="pane-label">{t('compare.pref.next')}</div>
          <p className="field-hint">{t('compare.pref.nextHint')}</p>
        </div>
        <button
          type="button"
          className="app-run-btn"
          disabled={!done}
          title={done ? undefined : t('compare.pref.finishAllFirst')}
          onClick={onOptimizeRoute}
        >
          {t('compare.pref.optimizeRoute')}
        </button>
      </section>
    </div>
  );
}
