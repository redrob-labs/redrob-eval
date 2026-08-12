import { NextResponse } from 'next/server';
import {
  advance,
  advanceGroup,
  aggregateTournament,
  appendVotes,
  bracketIsSettled,
  readTournament,
  writeTournamentMeta,
  type VoteWinner,
} from '@redrob/harness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ runId: string }> };

type VoteBody = {
  promptId: string;
  matchId: string;
  /** Head-to-head ballot: which side won. */
  winner?: VoteWinner;
  /** Group ballot: the id that won, or null for a tie across the whole ballot. */
  winnerModelId?: string | null;
};

/**
 * POST /api/compare/tournament/[runId]/vote — record one blind vote and
 * advance that prompt's bracket.
 */
export async function POST(request: Request, context: Ctx) {
  const { runId } = await context.params;

  let body: VoteBody;
  try {
    body = (await request.json()) as VoteBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const isGroupBallot = 'winnerModelId' in body;
  if (!body.promptId || !body.matchId || (!body.winner && !isGroupBallot)) {
    return NextResponse.json(
      { error: 'Provide promptId, matchId and a winner' },
      { status: 400 },
    );
  }

  try {
    const run = await readTournament(runId);
    const bracket = run.brackets.find((b) => b.promptId === body.promptId);
    if (!bracket) {
      return NextResponse.json(
        { error: `Unknown prompt: ${body.promptId}` },
        { status: 400 },
      );
    }

    // A group ballot is one human decision that stands for several pairings, so
    // it comes back as several votes.
    const newVotes = bracket.group
      ? advanceGroup(bracket, body.matchId, body.winnerModelId ?? null).votes
      : [advance(bracket, body.matchId, body.winner!).vote];
    await appendVotes(runId, newVotes);

    const votes = [...run.votes, ...newVotes];
    const allResolved = run.brackets.every(bracketIsSettled);
    const meta = {
      ...run.meta,
      finishedAt: allResolved ? new Date().toISOString() : null,
    };
    await writeTournamentMeta(meta, run.brackets);

    return NextResponse.json({
      meta,
      brackets: run.brackets,
      votes,
      aggregate: aggregateTournament({ brackets: run.brackets, votes }),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Vote failed' },
      { status: 400 },
    );
  }
}
