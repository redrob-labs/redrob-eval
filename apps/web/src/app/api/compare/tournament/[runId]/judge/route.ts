import { NextResponse } from 'next/server';
import {
  advance,
  aggregateTournament,
  appendVote,
  readTournament,
  writeTournamentMeta,
} from '@redrob/harness';
import { getModality } from '@/lib/modality';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ runId: string }> };

type JudgeBody = {
  promptId: string;
  matchId: string;
  judgeModelId?: string;
};

/**
 * POST /api/compare/tournament/[runId]/judge — let the modality's model judge
 * decide one match. The verdict is recorded as an ordinary vote, so a human can
 * see it in the standings and disagree by voting the rest of the bracket.
 */
export async function POST(request: Request, context: Ctx) {
  const { runId } = await context.params;

  let body: JudgeBody;
  try {
    body = (await request.json()) as JudgeBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body.promptId || !body.matchId) {
    return NextResponse.json({ error: 'Provide promptId and matchId' }, { status: 400 });
  }

  try {
    const run = await readTournament(runId);
    const modality = getModality(run.meta.modality);
    if (!modality?.judgeMatch) {
      return NextResponse.json(
        { error: `${run.meta.modality} matches are human-voted only` },
        { status: 400 },
      );
    }

    const bracket = run.brackets.find((b) => b.promptId === body.promptId);
    if (!bracket) {
      return NextResponse.json(
        { error: `Unknown prompt: ${body.promptId}` },
        { status: 400 },
      );
    }
    const match = bracket.rounds.flat().find((m) => m.matchId === body.matchId);
    if (!match?.a || !match.b) {
      return NextResponse.json({ error: 'Match is not ready to judge' }, { status: 400 });
    }

    const a = bracket.competitors.find((c) => c.modelId === match.a);
    const b = bracket.competitors.find((c) => c.modelId === match.b);
    if (!a || !b) {
      return NextResponse.json({ error: 'Match is missing an answer' }, { status: 400 });
    }

    const verdict = await modality.judgeMatch({
      promptText: bracket.promptText,
      a: { modelId: a.modelId, answer: a.answer },
      b: { modelId: b.modelId, answer: b.answer },
      judgeModelId: body.judgeModelId,
    });

    const { vote } = advance(bracket, body.matchId, verdict.winner);
    await appendVote(runId, vote);

    const votes = [...run.votes, vote];
    const allResolved = run.brackets.every((br) => br.championModelId != null);
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
      rationale: verdict.rationale,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Judge failed' },
      { status: 400 },
    );
  }
}
