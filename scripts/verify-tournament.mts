/**
 * Offline checks for the blind World Cup preference bracket.
 * No network, no provider keys.
 */
import assert from 'node:assert/strict';
import {
  activeContenders,
  advance,
  advanceGroup,
  aggregateTournament,
  bracketIsSettled,
  createBracket,
  eliminateFromGroup,
  foldVoteLog,
  groupIsPending,
  GROUP_VOTE_MAX,
  nextPendingMatch,
  rankBracket,
  rankGroup,
  resolvedMatches,
  totalMatches,
} from '../packages/harness/src/lib/tournament/index.ts';
import type {
  Competitor,
  Vote,
  VoteLogEntry,
} from '../packages/harness/src/lib/tournament/types.ts';
import { labelsFromPreference } from '../packages/harness/src/lib/routing-data/labels-from-preference.ts';

function field(n: number, opts?: { errorOn?: string[] }): Competitor[] {
  return Array.from({ length: n }, (_, i) => {
    const modelId = `m${i + 1}`;
    return {
      modelId,
      label: `Model ${i + 1}`,
      answer: `answer from ${modelId}`,
      error: opts?.errorOn?.includes(modelId) ? 'call failed' : undefined,
    };
  });
}

/**
 * Decide everything pending in favour of the lexicographically smallest id,
 * skipping answers that errored the way a reader would.
 */
function playOut(bracket: ReturnType<typeof createBracket>): Vote[] {
  const votes: Vote[] = [];
  const broken = new Set(
    bracket.competitors.filter((c) => c.error).map((c) => c.modelId),
  );
  const pick = (a: string, b: string) => {
    if (broken.has(a)) return 'b' as const;
    if (broken.has(b)) return 'a' as const;
    return a < b ? ('a' as const) : ('b' as const);
  };

  if (bracket.group) {
    if (!groupIsPending(bracket)) return votes;
    const winner = bracket.group.contenders.slice().sort()[0]!;
    votes.push(...advanceGroup(bracket, bracket.group.matchId, winner).votes);
    return votes;
  }

  let guard = 0;
  while (guard++ < 100) {
    const match = nextPendingMatch(bracket);
    if (!match) break;
    votes.push(advance(bracket, match.matchId, pick(match.a!, match.b!)).vote);
  }
  return votes;
}

// A field that fits on one screen is one ballot, never a bracket
for (const n of [2, 3, 4]) {
  const b = createBracket({ promptId: `g${n}`, promptText: 'q', competitors: field(n) });
  assert.equal(b.rounds.length, 0, `field of ${n} skips the bracket`);
  assert.equal(b.group?.contenders.length, n, `field of ${n} puts everyone on the ballot`);
  assert.equal(totalMatches(b), 1, `field of ${n} is a single decision`);
  assert.equal(b.championModelId, null, 'no champion before voting');
  assert.equal(bracketIsSettled(b), false, 'the ballot is waiting on a vote');

  const votes = playOut(b);
  assert.equal(b.championModelId, 'm1', 'lowest id wins under our vote rule');
  assert.equal(votes.length, n - 1, 'the winner is logged against each model it beat');
  assert.equal(resolvedMatches(b), 1, 'the ballot is resolved');
  assert.equal(bracketIsSettled(b), true, 'nothing left to vote on');
}

// A group tie names no winner and ties every pair
{
  const b = createBracket({ promptId: 'gtie', promptText: 'q', competitors: field(3) });
  const { votes } = advanceGroup(b, b.group!.matchId, null);
  assert.equal(b.championModelId, null, 'a tie crowns nobody');
  assert.equal(votes.length, 3, 'three contenders make three tied pairs');
  assert.equal(votes.every((v) => v.winner === 'tie'), true);
  assert.equal(bracketIsSettled(b), true, 'a tie still settles the prompt');
}

// A group vote says nothing about the models the voter passed over
{
  const b = createBracket({ promptId: 'gpair', promptText: 'q', competitors: field(3) });
  const { votes } = advanceGroup(b, b.group!.matchId, 'm2');
  const pairs = votes.map((v) => `${v.aModelId}>${v.bModelId}`).sort();
  assert.deepEqual(pairs, ['m2>m1', 'm2>m3'], 'only the winner gets head-to-head rows');
}

// Eliminating one answer at a time settles the ballot and orders the field
{
  const b = createBracket({ promptId: 'gout', promptText: 'q', competitors: field(4) });
  const matchId = b.group!.matchId;

  const first = eliminateFromGroup(b, matchId, 'm3').votes;
  assert.equal(first.length, 3, 'the three still standing each beat the one that went out');
  assert.equal(
    first.every((v) => v.bModelId === 'm3' && v.winner === 'a'),
    true,
    'an elimination is only evidence against the answer eliminated',
  );
  assert.deepEqual(activeContenders(b.group!).sort(), ['m1', 'm2', 'm4']);
  assert.equal(b.championModelId, null, 'three left is not a decision yet');
  assert.equal(bracketIsSettled(b), false, 'the ballot is still open');

  eliminateFromGroup(b, matchId, 'm1');
  eliminateFromGroup(b, matchId, 'm4');
  assert.equal(b.championModelId, 'm2', 'the last one standing wins the prompt');
  assert.deepEqual(
    b.group?.ranking,
    ['m2', 'm4', 'm1', 'm3'],
    'the order they went out is the ranking, worst last',
  );
  assert.equal(bracketIsSettled(b), true);
  assert.throws(
    () => eliminateFromGroup(b, matchId, 'm2'),
    /already resolved/,
    'a decided ballot takes no more votes',
  );
}

// A ranking is a claim about every pair, so every pair is recorded
{
  const b = createBracket({ promptId: 'grank', promptText: 'q', competitors: field(4) });
  const { votes } = rankGroup(b, b.group!.matchId, ['m4', 'm1', 'm3', 'm2']);
  assert.equal(votes.length, 6, 'four answers make six pairs');
  assert.equal(b.championModelId, 'm4', 'the top of the ranking wins the prompt');
  assert.deepEqual(b.group?.ranking, ['m4', 'm1', 'm3', 'm2']);
  assert.deepEqual(b.group?.eliminated, ['m2', 'm3', 'm1'], 'worst first, as if eliminated');

  const agg = aggregateTournament({ brackets: [b], votes });
  assert.equal(agg.winMatrix.m1?.m3, 1, 'a mid-table pair is judged too');
  assert.equal(agg.winMatrix.m3?.m1, 0);
  assert.deepEqual(agg.rankingByPrompt.grank, ['m4', 'm1', 'm3', 'm2']);
}

// A ranking has to place the whole field
{
  const b = createBracket({ promptId: 'gpartial', promptText: 'q', competitors: field(3) });
  assert.throws(
    () => rankGroup(b, b.group!.matchId, ['m1', 'm2']),
    /every answer/,
    'a partial order is not a ranking',
  );
  assert.throws(
    () => rankGroup(b, b.group!.matchId, ['m1', 'm1', 'm2']),
    /twice/,
    'an answer cannot hold two places',
  );
  assert.equal(groupIsPending(b), true, 'a refused ranking leaves the ballot open');
}

// Picking a winner refuses to invent an order for the answers passed over
{
  const b = createBracket({ promptId: 'gpick', promptText: 'q', competitors: field(3) });
  advanceGroup(b, b.group!.matchId, 'm2');
  assert.equal(b.group?.ranking ?? null, null, 'picking a winner is not a ranking');
  assert.equal(rankBracket(b)[0], 'm2', 'the winner still leads the prompt');
  assert.equal(rankBracket(b).length, 3, 'the rest follow in the order they were shown');
}

// Above the group limit the field still plays out as a bracket
for (const n of [GROUP_VOTE_MAX + 1, 6, 7, 9]) {
  const b = createBracket({ promptId: `p${n}`, promptText: 'q', competitors: field(n) });
  assert.equal(b.group, null, `field of ${n} is too wide to read side by side`);
  playOut(b);
  assert.ok(b.championModelId, `field of ${n} produced a champion`);
  assert.equal(
    resolvedMatches(b),
    totalMatches(b),
    `field of ${n} resolved every non-bye match`,
  );
  assert.ok(
    field(n).some((c) => c.modelId === b.championModelId),
    `field of ${n} champion is a real competitor`,
  );
}

// A knockout is ranked by how far each answer got
{
  const b = createBracket({ promptId: 'krank', promptText: 'q', competitors: field(8) });
  playOut(b);
  const order = rankBracket(b);
  assert.equal(order.length, 8, 'every competitor is placed');
  assert.equal(order[0], b.championModelId, 'the champion leads');
  assert.equal(new Set(order).size, 8, 'nobody is placed twice');
  assert.deepEqual(
    aggregateTournament({ brackets: [b], votes: [] }).rankingByPrompt.krank,
    order,
    'the aggregate reports the same order',
  );
}

// An open prompt has no ranking to report
{
  const b = createBracket({ promptId: 'kopen', promptText: 'q', competitors: field(8) });
  assert.deepEqual(rankBracket(b), [], 'nothing is placed before the prompt is decided');
}

// Retracting a prompt drops its votes and leaves the others alone
{
  const kept: Vote[] = [
    {
      promptId: 'other',
      matchId: 'other:group',
      round: 0,
      aModelId: 'm1',
      bModelId: 'm2',
      winner: 'a',
      winnerModelId: 'm1',
      votedAt: '2026-01-01T00:00:00.000Z',
    },
  ];
  const dropped: Vote[] = [{ ...kept[0]!, promptId: 'p1', matchId: 'p1:group' }];
  const recast: Vote[] = [{ ...dropped[0]!, winnerModelId: 'm2', aModelId: 'm2', bModelId: 'm1' }];
  const log: VoteLogEntry[] = [
    ...dropped,
    ...kept,
    { kind: 'undo', promptId: 'p1', undoneAt: '2026-01-01T00:01:00.000Z' },
    ...recast,
  ];
  const folded = foldVoteLog(log);
  assert.equal(folded.length, 2, 'the retracted vote is gone and the new one stands');
  assert.equal(folded.filter((v) => v.promptId === 'p1').length, 1);
  assert.equal(folded.find((v) => v.promptId === 'p1')?.winnerModelId, 'm2');
  assert.equal(folded.some((v) => v.promptId === 'other'), true, 'other prompts are untouched');
}

// A single competitor is champion by default
{
  const b = createBracket({ promptId: 'solo', promptText: 'q', competitors: field(1) });
  assert.equal(b.championModelId, 'm1');
  assert.equal(nextPendingMatch(b), null);
  assert.equal(bracketIsSettled(b), true);
}

// An errored model never reaches the ballot
{
  const b = createBracket({
    promptId: 'err',
    promptText: 'q',
    competitors: field(2, { errorOn: ['m1'] }),
  });
  assert.equal(b.championModelId, 'm2', 'a failed call cannot win');
  assert.deepEqual(b.group?.contenders, ['m2'], 'the failed answer is off the ballot');
  assert.equal(groupIsPending(b), false, 'a walkover needs no vote');
  assert.equal(totalMatches(b), 0, 'a walkover is not a decision the voter made');
}

// An errored model in a wider field loses its first match without a vote
{
  const b = createBracket({
    promptId: 'errwide',
    promptText: 'q',
    competitors: field(5, { errorOn: ['m1'] }),
  });
  playOut(b);
  assert.notEqual(b.championModelId, 'm1', 'a failed call cannot win');
}

// Aggregation counts champions, head-to-head wins and ties
{
  const brackets = ['a', 'b', 'c'].map((id) =>
    createBracket({ promptId: id, promptText: 'q', competitors: field(2) }),
  );
  const votes = brackets.flatMap((b) => playOut(b));
  const agg = aggregateTournament({ brackets, votes });

  assert.equal(agg.overallChampionModelId, 'm1', 'm1 won every prompt');
  assert.equal(agg.winnerByPrompt.a, 'm1');
  assert.equal(agg.matchesVoted, agg.matchesTotal);
  assert.equal(agg.winMatrix.m1?.m2, 3, 'm1 beat m2 three times');
  assert.equal(agg.standings[0]?.modelId, 'm1');
  assert.equal(agg.standings[0]?.winRate, 1);
}

// A tie is recorded as a tie for both models
{
  const b = createBracket({ promptId: 'tie', promptText: 'q', competitors: field(2) });
  const { votes } = advanceGroup(b, b.group!.matchId, null);
  const vote = votes[0]!;
  assert.equal(vote.winner, 'tie');
  assert.equal(vote.winnerModelId, null, 'a tie names no winner in the log');
  assert.equal(b.championModelId, null, 'a tie crowns nobody');

  const agg = aggregateTournament({ brackets: [b], votes });
  assert.equal(agg.standings.every((s) => s.ties === 1), true, 'both models get a tie');
  assert.equal(agg.standings.every((s) => s.wins === 0), true, 'a tie is not a win');
}

// Bracket outcomes become routing labels: the fast model carries what it wins
{
  const brackets = ['p1', 'p2', 'p3', 'p4'].map((id) =>
    createBracket({ promptId: id, promptText: `prompt ${id}`, competitors: field(2) }),
  );
  const votes = brackets.flatMap((b) => playOut(b));

  // m1 won every prompt, so naming it the fast model routes everything small.
  const fast = labelsFromPreference({
    brackets,
    votes,
    smallModelId: 'm1',
    largeModelId: 'm2',
    runId: '2026-01-01_000000_pref',
    sourceRunId: 'run-x',
  });
  assert.equal(fast.examples.length, 4, 'one label per prompt');
  assert.equal(fast.saveRate, 1, 'the winning model carries every prompt');
  assert.equal(
    fast.examples.every((e) => e.label === 'small'),
    true,
    'every prompt routes to the fast model',
  );

  // Flip the roles and the loser has to escalate on every prompt.
  const slow = labelsFromPreference({
    brackets,
    votes,
    smallModelId: 'm2',
    largeModelId: 'm1',
    runId: '2026-01-01_000000_pref',
    sourceRunId: 'run-x',
  });
  assert.equal(slow.saveRate, 0, 'the losing model carries nothing');
  assert.equal(
    slow.examples.every((e) => e.label === 'large'),
    true,
    'every prompt escalates',
  );

  // Prompts where a designated model never competed are skipped, not guessed.
  const missing = labelsFromPreference({
    brackets,
    votes,
    smallModelId: 'm1',
    largeModelId: 'nobody',
    runId: '2026-01-01_000000_pref',
    sourceRunId: 'run-x',
  });
  assert.equal(missing.examples.length, 0, 'absent model produces no labels');
  assert.equal(missing.skipped, 4, 'every prompt is reported as skipped');
}

// A tie counts as the fast model holding its own
{
  const b = createBracket({
    promptId: 'tie2',
    promptText: 'q',
    competitors: field(2),
  });
  const { votes } = advanceGroup(b, b.group!.matchId, null);
  const labelled = labelsFromPreference({
    brackets: [b],
    votes,
    smallModelId: 'm2',
    largeModelId: 'm1',
    runId: '2026-01-01_000000_pref',
    sourceRunId: 'run-x',
  });
  assert.equal(labelled.examples[0]?.label, 'small', 'a tie is good enough for small');
}

// An errored fast model always escalates
{
  const b = createBracket({
    promptId: 'errlabel',
    promptText: 'q',
    competitors: field(2, { errorOn: ['m1'] }),
  });
  const labelled = labelsFromPreference({
    brackets: [b],
    votes: [],
    smallModelId: 'm1',
    largeModelId: 'm2',
    runId: '2026-01-01_000000_pref',
    sourceRunId: 'run-x',
  });
  assert.equal(labelled.examples[0]?.label, 'large', 'a failed fast call escalates');
}

console.log('verify-tournament: all checks passed');
