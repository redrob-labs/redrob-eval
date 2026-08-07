import { NextResponse } from 'next/server';
import { aggregateTournament, readTournament } from '@redrob/harness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ runId: string }> };

/** GET /api/compare/tournament/[runId] — full state plus current standings. */
export async function GET(_request: Request, context: Ctx) {
  const { runId } = await context.params;
  try {
    const run = await readTournament(runId);
    return NextResponse.json({
      ...run,
      aggregate: aggregateTournament({ brackets: run.brackets, votes: run.votes }),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Tournament not found' },
      { status: 404 },
    );
  }
}
