import { NextResponse } from 'next/server';
import {
  aggregateTournament,
  appendVoteUndo,
  bracketIsSettled,
  createBracket,
  readTournament,
  writeTournamentMeta,
} from '@redrob/harness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ runId: string }> };

type UndoBody = { promptId: string };

/**
 * POST /api/compare/tournament/[runId]/undo — clear one prompt's votes so it
 * can be voted again.
 *
 * A whole prompt at a time, not a single match. Undoing one match of a
 * knockout would leave the rounds after it holding a winner nobody voted for,
 * and rebuilding the bracket from the answers is the one state that is always
 * consistent. Byes and errored competitors resolve again on their own.
 */
export async function POST(request: Request, context: Ctx) {
  const { runId } = await context.params;

  let body: UndoBody;
  try {
    body = (await request.json()) as UndoBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body.promptId) {
    return NextResponse.json({ error: 'Provide promptId' }, { status: 400 });
  }

  try {
    const run = await readTournament(runId);
    const index = run.brackets.findIndex((b) => b.promptId === body.promptId);
    if (index < 0) {
      return NextResponse.json(
        { error: `Unknown prompt: ${body.promptId}` },
        { status: 400 },
      );
    }

    const previous = run.brackets[index]!;
    run.brackets[index] = createBracket({
      promptId: previous.promptId,
      promptText: previous.promptText,
      competitors: previous.competitors,
    });
    await appendVoteUndo(runId, body.promptId);

    const votes = run.votes.filter((v) => v.promptId !== body.promptId);
    const meta = {
      ...run.meta,
      finishedAt: run.brackets.every(bracketIsSettled) ? new Date().toISOString() : null,
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
      { error: e instanceof Error ? e.message : 'Undo failed' },
      { status: 400 },
    );
  }
}
