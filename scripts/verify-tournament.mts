/**
 * Offline checks for the blind World Cup preference bracket.
 * No network, no provider keys.
 */
import assert from 'node:assert/strict';
import {
  advance,
  aggregateTournament,
  createBracket,
  nextPendingMatch,
  resolvedMatches,
  totalMatches,
} from '../packages/harness/src/lib/tournament/index.ts';
import type { Competitor } from '../packages/harness/src/lib/tournament/types.ts';
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

/** Vote every pending match for the lexicographically smallest model id. */
function playOut(bracket: ReturnType<typeof createBracket>) {
  const votes = [];
  let guard = 0;
  while (guard++ < 100) {
    const match = nextPendingMatch(bracket);
    if (!match) break;
    const winner = match.a! < match.b! ? 'a' : 'b';
    votes.push(advance(bracket, match.matchId, winner).vote);
  }
  return votes;
}

// A power-of-two field plays a clean 4 -> 2 -> 1
{
  const b = createBracket({ promptId: 'p1', promptText: 'q', competitors: field(4) });
  assert.equal(b.rounds.length, 2, 'four competitors take two rounds');
  assert.equal(totalMatches(b), 3, 'four competitors play three matches');
  assert.equal(b.championModelId, null, 'no champion before voting');
  playOut(b);
  assert.equal(b.championModelId, 'm1', 'lowest id wins under our vote rule');
  assert.equal(resolvedMatches(b), 3, 'every match resolved');
}

// A non-power-of-two field pads with byes and still resolves
for (const n of [3, 5, 6, 7, 9]) {
  const b = createBracket({ promptId: `p${n}`, promptText: 'q', competitors: field(n) });
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

// A single competitor is champion by default
{
  const b = createBracket({ promptId: 'solo', promptText: 'q', competitors: field(1) });
  assert.equal(b.championModelId, 'm1');
  assert.equal(nextPendingMatch(b), null);
}

// An errored model loses its first match without a human vote
{
  const b = createBracket({
    promptId: 'err',
    promptText: 'q',
    competitors: field(2, { errorOn: ['m1'] }),
  });
  assert.equal(b.championModelId, 'm2', 'a failed call cannot win');
  assert.equal(nextPendingMatch(b), null, 'walkover needs no vote');
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

// A tie advances side A but is recorded as a tie for both models
{
  const b = createBracket({ promptId: 'tie', promptText: 'q', competitors: field(2) });
  const match = nextPendingMatch(b)!;
  const { vote } = advance(b, match.matchId, 'tie');
  assert.equal(vote.winner, 'tie');
  assert.equal(vote.winnerModelId, null, 'a tie names no winner in the log');
  assert.equal(b.championModelId, match.a, 'side A advances so the bracket can finish');

  const agg = aggregateTournament({ brackets: [b], votes: [vote] });
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
  const match = nextPendingMatch(b)!;
  const { vote } = advance(b, match.matchId, 'tie');
  const labelled = labelsFromPreference({
    brackets: [b],
    votes: [vote],
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
