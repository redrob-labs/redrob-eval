import { NextResponse } from 'next/server';
import {
  advance,
  aggregateTournament,
  appendVote,
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
  winner: VoteWinner;
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
  if (!body.promptId || !body.matchId || !body.winner) {
    return NextResponse.json(
      { error: 'Provide promptId, matchId and winner' },
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

    const { vote } = advance(bracket, body.matchId, body.winner);
    await appendVote(runId, vote);

    const votes = [...run.votes, vote];
    const allResolved = run.brackets.every((b) => b.championModelId != null);
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
