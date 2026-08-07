import { championOf, resolvedMatches, totalMatches } from './bracket';
import type {
  Bracket,
  ModelStanding,
  TournamentAggregate,
  Vote,
} from './types';

/**
 * Roll per-prompt brackets and the raw vote log into standings.
 *
 * Champion counts come from the brackets (they include walkovers and byes);
 * win/loss/tie counts come from the votes, because only a vote is evidence of
 * a human preferring one answer over another.
 */
export function aggregateTournament(params: {
  brackets: Bracket[];
  votes: Vote[];
  labels?: Record<string, string>;
}): TournamentAggregate {
  const { brackets, votes } = params;
  const labels = params.labels ?? {};

  const modelIds = new Set<string>();
  for (const b of brackets) for (const c of b.competitors) modelIds.add(c.modelId);

  const winMatrix: Record<string, Record<string, number>> = {};
  for (const a of modelIds) {
    winMatrix[a] = {};
    for (const b of modelIds) if (a !== b) winMatrix[a]![b] = 0;
  }

  const wins: Record<string, number> = {};
  const losses: Record<string, number> = {};
  const ties: Record<string, number> = {};
  for (const id of modelIds) {
    wins[id] = 0;
    losses[id] = 0;
    ties[id] = 0;
  }

  for (const vote of votes) {
    if (vote.winner === 'tie') {
      ties[vote.aModelId] = (ties[vote.aModelId] ?? 0) + 1;
      ties[vote.bModelId] = (ties[vote.bModelId] ?? 0) + 1;
      continue;
    }
    const winner = vote.winnerModelId;
    if (!winner) continue;
    const loser = winner === vote.aModelId ? vote.bModelId : vote.aModelId;
    wins[winner] = (wins[winner] ?? 0) + 1;
    losses[loser] = (losses[loser] ?? 0) + 1;
    if (winMatrix[winner]) {
      winMatrix[winner]![loser] = (winMatrix[winner]![loser] ?? 0) + 1;
    }
  }

  const winnerByPrompt: Record<string, string | null> = {};
  const championCounts: Record<string, number> = {};
  for (const bracket of brackets) {
    const champion = championOf(bracket);
    winnerByPrompt[bracket.promptId] = champion;
    if (champion) championCounts[champion] = (championCounts[champion] ?? 0) + 1;
  }

  const labelFor = (id: string) =>
    labels[id] ??
    brackets.flatMap((b) => b.competitors).find((c) => c.modelId === id)?.label ??
    id;

  const standings: ModelStanding[] = Array.from(modelIds)
    .map((modelId): ModelStanding => {
      const w = wins[modelId] ?? 0;
      const l = losses[modelId] ?? 0;
      const t = ties[modelId] ?? 0;
      const played = w + l + t;
      return {
        modelId,
        label: labelFor(modelId),
        championOf: championCounts[modelId] ?? 0,
        wins: w,
        losses: l,
        ties: t,
        winRate: played > 0 ? w / played : 0,
      };
    })
    .sort(
      (a, b) =>
        b.championOf - a.championOf || b.winRate - a.winRate || b.wins - a.wins,
    );

  const top = standings[0];
  return {
    overallChampionModelId: top && top.championOf > 0 ? top.modelId : null,
    standings,
    winnerByPrompt,
    winMatrix,
    matchesTotal: brackets.reduce((sum, b) => sum + totalMatches(b), 0),
    matchesVoted: brackets.reduce((sum, b) => sum + resolvedMatches(b), 0),
  };
}
