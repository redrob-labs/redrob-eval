'use client';

import { useCallback, useMemo, useState } from 'react';
import { useT } from '@/components/LocaleProvider';
import { VoteCard } from './VoteCard';
import type { Bracket, Modality, TournamentState, VoteWinner } from './types';

/** Letters shown in place of model names, so the ballot stays blind. */
const SIDES = 'ABCDEFGH';

/** The three things a voter can say about a group ballot. */
type BallotMode = 'pick' | 'rank' | 'eliminate';

function pendingMatch(bracket: Bracket) {
  for (const round of bracket.rounds) {
    for (const match of round) {
      if (!match.winnerModelId && match.a && match.b) return match;
    }
  }
  return null;
}

function groupIsOpen(bracket: Bracket) {
  const group = bracket.group;
  return Boolean(group && !group.winnerModelId && !group.tie && group.contenders.length > 1);
}

/** True while this prompt still needs a human. */
function isPending(bracket: Bracket) {
  return bracket.group ? groupIsOpen(bracket) : pendingMatch(bracket) != null;
}

/** Answers still standing on a group ballot. */
function standing(bracket: Bracket) {
  const group = bracket.group;
  if (!group) return [];
  const out = new Set(group.eliminated ?? []);
  return group.contenders.filter((id) => !out.has(id));
}

/**
 * The letter each answer wears for this prompt.
 *
 * Taken from the bracket's own seeded order rather than the model list, so the
 * same model is not always A. A stable letter is what lets the standings and
 * the per-prompt table talk about an answer while identities stay hidden.
 */
function sideLetters(bracket: Bracket): Map<string, string> {
  const seeded = bracket.group
    ? [...bracket.group.contenders]
    : bracket.rounds[0]?.flatMap((m) => [m.a, m.b]).filter((id): id is string => Boolean(id)) ??
      [];
  for (const competitor of bracket.competitors) {
    if (!seeded.includes(competitor.modelId)) seeded.push(competitor.modelId);
  }
  return new Map(seeded.map((id, i) => [id, SIDES[i] ?? String(i + 1)]));
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
  /** Knock one answer off a group ballot and leave the rest standing. */
  onEliminate: (promptId: string, matchId: string, modelId: string) => Promise<void>;
  /** Place every answer on a group ballot at once, best first. */
  onRank: (promptId: string, matchId: string, ranking: string[]) => Promise<void>;
  /** Clear a prompt's votes so it can be voted again. */
  onRevote: (promptId: string) => Promise<void>;
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
    onEliminate,
    onRank,
    onRevote,
    onJudge,
    hint,
    onOptimizeRoute,
  } = props;
  const t = useT();
  const [voting, setVoting] = useState(false);
  const [mode, setMode] = useState<BallotMode>('pick');
  /**
   * The prompt on screen when it is not simply the next one waiting.
   *
   * `held` is what the voter asked for: navigating to a prompt holds it there
   * even after it is decided, which is the whole point of going back to look.
   * Voting drops the hold, so once that prompt is settled the queue resumes on
   * its own instead of stranding the voter on a finished ballot.
   */
  const [pinned, setPinned] = useState<{ promptId: string; held: boolean } | null>(null);
  /** Placed so far in ranking mode, best first, tied to the prompt it belongs to. */
  const [placement, setPlacement] = useState<{ promptId: string; order: string[] }>({
    promptId: '',
    order: [],
  });

  const brackets = useMemo(() => state?.brackets ?? [], [state]);
  const firstPendingIndex = brackets.findIndex(isPending);
  const pinnedIndex = pinned
    ? brackets.findIndex((b) => b.promptId === pinned.promptId)
    : -1;
  const holdsPin =
    pinnedIndex >= 0 && (pinned!.held || isPending(brackets[pinnedIndex]!));
  const viewIndex = holdsPin
    ? pinnedIndex
    : firstPendingIndex >= 0
      ? firstPendingIndex
      : brackets.length - 1;
  const bracket = brackets[viewIndex] ?? null;
  const open = bracket ? isPending(bracket) : false;
  const match = bracket && !bracket.group ? pendingMatch(bracket) : null;
  const letters = useMemo(() => (bracket ? sideLetters(bracket) : new Map()), [bracket]);
  const placed = placement.promptId === bracket?.promptId ? placement.order : [];

  const place = useCallback(
    (order: string[]) => {
      if (!bracket) return;
      setPlacement({ promptId: bracket.promptId, order });
    },
    [bracket],
  );

  const goTo = useCallback((target: string | null) => {
    setPinned(target ? { promptId: target, held: true } : null);
  }, []);

  const cast = useCallback(
    async (action: () => Promise<void>) => {
      if (voting) return;
      setVoting(true);
      setPinned((prev) => (prev ? { ...prev, held: false } : prev));
      try {
        await action();
      } finally {
        setVoting(false);
      }
    },
    [voting],
  );

  const vote = useCallback(
    (winner: VoteWinner) => {
      if (!bracket || !match) return;
      void cast(() => onVote(bracket.promptId, match.matchId, winner));
    },
    [bracket, cast, match, onVote],
  );

  const voteGroup = useCallback(
    (winnerModelId: string | null) => {
      if (!bracket?.group) return;
      void cast(() => onGroupVote(bracket.promptId, bracket.group!.matchId, winnerModelId));
    },
    [bracket, cast, onGroupVote],
  );

  const eliminate = useCallback(
    (modelId: string) => {
      if (!bracket?.group) return;
      void cast(() => onEliminate(bracket.promptId, bracket.group!.matchId, modelId));
    },
    [bracket, cast, onEliminate],
  );

  const submitRanking = useCallback(
    (order: string[]) => {
      if (!bracket?.group) return;
      place([]);
      void cast(() => onRank(bracket.promptId, bracket.group!.matchId, order));
    },
    [bracket, cast, onRank, place],
  );

  const revote = useCallback(() => {
    if (!bracket) return;
    const target = bracket.promptId;
    place([]);
    // Stay on the prompt being cleared: the point of undoing it is to vote it again.
    goTo(target);
    void cast(() => onRevote(target));
  }, [bracket, cast, goTo, onRevote, place]);

  const judge = useCallback(() => {
    if (!bracket || !onJudge) return;
    const matchId = bracket.group?.matchId ?? match?.matchId;
    if (!matchId) return;
    void cast(() => onJudge(bracket.promptId, matchId));
  }, [bracket, cast, match, onJudge]);

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
  /**
   * Names stay hidden while any prompt is still open. Revealing the winner of a
   * decided prompt would tell the voter which model they are reading on the
   * next one, and a blind vote that can be reasoned back to a brand is not one.
   */
  const revealed = firstPendingIndex < 0;
  const labelOf = (modelId: string) =>
    aggregate.standings.find((s) => s.modelId === modelId)?.label ?? modelId;

  // A prompt where every rival errored is awarded to the one answer that exists.
  // Say so, otherwise the standings look like they moved on their own.
  const walkovers = state.brackets.filter(
    (b) => b.championModelId && b.competitors.filter((c) => !c.error).length <= 1,
  ).length;

  const active = bracket ? standing(bracket) : [];
  const unplaced = active.filter((id) => !placed.includes(id));
  const rankingComplete = unplaced.length <= 1;
  const ranking = bracket ? (aggregate.rankingByPrompt[bracket.promptId] ?? []) : [];
  const eliminated = bracket?.group?.eliminated ?? [];

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
              {bracket
                ? ` · ${t('compare.pref.promptPosition', {
                    index: viewIndex + 1,
                    total: brackets.length,
                  })}`
                : ''}
              {match ? ` · ${t('compare.pref.round', { round: match.round + 1 })}` : ''}
            </p>
          </div>
          <div className="cmp-pref-nav">
            <button
              type="button"
              className="app-ghost-btn"
              disabled={viewIndex <= 0}
              onClick={() => goTo(brackets[viewIndex - 1]?.promptId ?? null)}
            >
              {t('compare.pref.nav.prev')}
            </button>
            <button
              type="button"
              className="app-ghost-btn"
              disabled={viewIndex >= brackets.length - 1}
              onClick={() => goTo(brackets[viewIndex + 1]?.promptId ?? null)}
            >
              {t('compare.pref.nav.next')}
            </button>
            <button
              type="button"
              className="app-ghost-btn"
              disabled={firstPendingIndex < 0 || firstPendingIndex === viewIndex}
              onClick={() => goTo(null)}
            >
              {t('compare.pref.nav.pending')}
            </button>
          </div>
        </div>
        {error ? <div className="app-banner error">{error}</div> : null}
      </section>

      {bracket ? (
        <section className="cmp-card">
          <div className="pane-label">{t('compare.pref.prompt')}</div>
          <pre className="cmp-prompt-text">{bracket.promptText}</pre>

          {open && bracket.group ? (
            <div className="cmp-pref-modes" role="group" aria-label={t('compare.pref.ballotMode')}>
              {(['pick', 'rank', 'eliminate'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`cmp-pref-mode${mode === m ? ' on' : ''}`}
                  aria-pressed={mode === m}
                  onClick={() => {
                    setMode(m);
                    place([]);
                  }}
                >
                  {t(`compare.pref.mode.${m}` as const)}
                </button>
              ))}
            </div>
          ) : null}

          {open && bracket.group ? (
            <p className="field-hint">{t(`compare.pref.modeHint.${mode}` as const)}</p>
          ) : null}

          {open ? (
            <>
              <div className={`vote-grid${bracket.group ? ' is-group' : ''}`}>
                {bracket.group
                  ? bracket.group.contenders.map((modelId) => {
                      const out = eliminated.includes(modelId);
                      const placedAt = placed.indexOf(modelId);
                      const canRank = mode === 'rank' && !out && placedAt < 0;
                      return (
                        <VoteCard
                          key={modelId}
                          side={letters.get(modelId) ?? '?'}
                          modality={modality}
                          answer={competitor(bracket, modelId)?.answer ?? ''}
                          error={competitor(bracket, modelId)?.error}
                          disabled={voting}
                          eliminated={out}
                          badge={
                            placedAt >= 0
                              ? t('compare.pref.place', { place: placedAt + 1 })
                              : null
                          }
                          onPick={
                            out
                              ? undefined
                              : mode === 'pick'
                                ? () => voteGroup(modelId)
                                : canRank
                                  ? () => place([...placed, modelId])
                                  : undefined
                          }
                          pickLabel={
                            mode === 'rank'
                              ? t('compare.pref.placeNext', { place: placed.length + 1 })
                              : undefined
                          }
                          secondary={
                            mode === 'eliminate' && !out && active.length > 1
                              ? {
                                  label: t('compare.pref.eliminate'),
                                  onClick: () => eliminate(modelId),
                                }
                              : null
                          }
                        />
                      );
                    })
                  : (['a', 'b'] as const).map((side) => {
                      const modelId = side === 'a' ? match!.a! : match!.b!;
                      return (
                        <VoteCard
                          key={side}
                          side={letters.get(modelId) ?? side.toUpperCase()}
                          modality={modality}
                          answer={competitor(bracket, modelId)?.answer ?? ''}
                          error={competitor(bracket, modelId)?.error}
                          disabled={voting}
                          onPick={() => vote(side)}
                        />
                      );
                    })}
              </div>

              <div className="cmp-actions">
                {mode === 'rank' && bracket.group ? (
                  <>
                    <button
                      type="button"
                      className="app-run-btn"
                      disabled={voting || !rankingComplete}
                      onClick={() => submitRanking([...placed, ...unplaced])}
                    >
                      {t('compare.pref.rankSubmit')}
                    </button>
                    <button
                      type="button"
                      className="app-ghost-btn"
                      disabled={voting || placed.length === 0}
                      onClick={() => place([])}
                    >
                      {t('compare.pref.rankReset')}
                    </button>
                  </>
                ) : null}
                <button
                  type="button"
                  className="app-ghost-btn"
                  disabled={voting}
                  onClick={() => (bracket.group ? voteGroup(null) : vote('tie'))}
                >
                  {t('compare.pref.tooCloseToCall')}
                </button>
                {onJudge ? (
                  <button
                    type="button"
                    className="app-ghost-btn"
                    disabled={voting}
                    title={t('compare.pref.judgeTitle')}
                    onClick={judge}
                  >
                    {t('compare.pref.letJudgeDecide')}
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <div className="cmp-pref-decided">
              <p className="field-hint">
                {bracket.group?.tie
                  ? t('compare.pref.tieRecorded')
                  : bracket.championModelId
                    ? t('compare.pref.promptWonBy', {
                        side: letters.get(bracket.championModelId) ?? '?',
                      })
                    : t('compare.pref.promptUnresolved')}
              </p>
              {ranking.length > 1 ? (
                <ol className="cmp-pref-order">
                  {ranking.map((modelId) => (
                    <li key={modelId}>
                      <span className="cmp-pref-order-side">{letters.get(modelId) ?? '?'}</span>
                      {revealed ? <span>{labelOf(modelId)}</span> : null}
                      {competitor(bracket, modelId)?.error ? (
                        <span className="cmp-pref-order-note">
                          {t('compare.pref.erroredHere')}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              ) : null}
              <div className="cmp-actions">
                <button
                  type="button"
                  className="app-ghost-btn"
                  disabled={voting}
                  onClick={revote}
                >
                  {t('compare.pref.revote')}
                </button>
              </div>
            </div>
          )}
        </section>
      ) : (
        <section className="cmp-card">
          <div className="pane-label">{t('compare.pref.title')}</div>
          <p className="field-hint">{t('compare.pref.noPrompts')}</p>
        </section>
      )}

      {firstPendingIndex < 0 ? (
        <section className="cmp-card">
          <div className="pane-label">{t('compare.pref.allDecided')}</div>
          <p className="field-hint">
            {aggregate.overallChampionModelId
              ? t('compare.pref.championWon', {
                  label: labelOf(aggregate.overallChampionModelId),
                })
              : t('compare.pref.noChampion')}
          </p>
        </section>
      ) : null}

      <section className="cmp-card">
        <div className="pane-label">{t('compare.pref.byPrompt')}</div>
        <p className="field-hint">
          {revealed ? t('compare.pref.lettersPerPrompt') : t('compare.pref.blindUntilDone')}
        </p>
        <div className="table-scroll">
          <table className="data-table text-xs">
            <thead>
              <tr>
                <th>{t('compare.pref.table.prompt')}</th>
                <th>{t('compare.pref.table.status')}</th>
                <th>{t('compare.pref.table.winner')}</th>
                <th>{t('compare.pref.table.knockedOut')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {brackets.map((b, i) => {
                const order = aggregate.rankingByPrompt[b.promptId] ?? [];
                const marks = sideLetters(b);
                const champion = b.championModelId;
                return (
                  <tr key={b.promptId} className={i === viewIndex ? 'is-current' : undefined}>
                    <td>{b.promptId}</td>
                    <td>
                      {isPending(b)
                        ? t('compare.pref.statusOpen')
                        : b.group?.tie
                          ? t('compare.pref.statusTie')
                          : t('compare.pref.statusDecided')}
                    </td>
                    <td>
                      {champion
                        ? revealed
                          ? labelOf(champion)
                          : (marks.get(champion) ?? '—')
                        : '—'}
                    </td>
                    <td>
                      {order.length > 1
                        ? order
                            .slice(1)
                            .map((id) => (revealed ? labelOf(id) : (marks.get(id) ?? '?')))
                            .join(' · ')
                        : '—'}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="app-ghost-btn"
                        onClick={() => goTo(b.promptId)}
                      >
                        {t('compare.pref.goToPrompt')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

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
