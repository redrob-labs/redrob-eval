import { NextResponse } from 'next/server';
import {
  activeContenders,
  advance,
  advanceGroup,
  aggregateTournament,
  appendVotes,
  bracketIsSettled,
  readTournament,
  writeTournamentMeta,
  type Bracket,
} from '@redrob/harness';
import { getModality } from '@/lib/modality';
import type { ModalityAdapter } from '@/lib/modality/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ runId: string }> };

type JudgeBody = {
  promptId: string;
  matchId: string;
  judgeModelId?: string;
};

type JudgeMatch = NonNullable<ModalityAdapter['judgeMatch']>;

/**
 * Decide a group ballot with a judge that only knows how to compare two
 * answers: run every pair and take the most wins. Ties in the standings stay
 * ties, so the judge is never forced into a coin flip it cannot justify.
 */
async function judgeGroup(
  bracket: Bracket,
  judgeMatch: JudgeMatch,
  judgeModelId?: string,
): Promise<{ winnerModelId: string | null; rationale: string }> {
  // Only what is still standing: handing the judge answers the voter already
  // knocked out would let it crown one of them.
  const contenders = bracket.group ? activeContenders(bracket.group) : [];
  const answerFor = (id: string) => bracket.competitors.find((c) => c.modelId === id);

  const wins = new Map(contenders.map((id) => [id, 0]));
  const notes: string[] = [];

  for (let i = 0; i < contenders.length; i += 1) {
    for (let j = i + 1; j < contenders.length; j += 1) {
      const a = answerFor(contenders[i]!);
      const b = answerFor(contenders[j]!);
      if (!a || !b) continue;
      const verdict = await judgeMatch({
        promptText: bracket.promptText,
        a: { modelId: a.modelId, answer: a.answer },
        b: { modelId: b.modelId, answer: b.answer },
        judgeModelId,
      });
      if (verdict.winner === 'a') wins.set(a.modelId, (wins.get(a.modelId) ?? 0) + 1);
      if (verdict.winner === 'b') wins.set(b.modelId, (wins.get(b.modelId) ?? 0) + 1);
      notes.push(`${a.label} vs ${b.label}: ${verdict.winner}. ${verdict.rationale}`);
    }
  }

  const ranked = [...wins.entries()].sort((x, y) => y[1] - x[1]);
  const clearWinner =
    ranked.length > 0 && (ranked.length === 1 || ranked[0]![1] > ranked[1]![1])
      ? ranked[0]![0]
      : null;

  return { winnerModelId: clearWinner, rationale: notes.join('\n') };
}

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
    const answerFor = (modelId: string) =>
      bracket.competitors.find((c) => c.modelId === modelId) ?? null;

    let newVotes;
    let rationale: string;

    if (bracket.group) {
      if (bracket.group.matchId !== body.matchId) {
        return NextResponse.json({ error: 'Unknown match' }, { status: 400 });
      }
      // The judge only ever compares two answers, so a group ballot is decided
      // by a round robin among the contenders and the most wins takes it.
      const { winnerModelId, rationale: why } = await judgeGroup(
        bracket,
        modality.judgeMatch,
        body.judgeModelId,
      );
      rationale = why;
      newVotes = advanceGroup(bracket, body.matchId, winnerModelId).votes;
    } else {
      const match = bracket.rounds.flat().find((m) => m.matchId === body.matchId);
      if (!match?.a || !match.b) {
        return NextResponse.json({ error: 'Match is not ready to judge' }, { status: 400 });
      }

      const a = answerFor(match.a);
      const b = answerFor(match.b);
      if (!a || !b) {
        return NextResponse.json({ error: 'Match is missing an answer' }, { status: 400 });
      }

      const verdict = await modality.judgeMatch({
        promptText: bracket.promptText,
        a: { modelId: a.modelId, answer: a.answer },
        b: { modelId: b.modelId, answer: b.answer },
        judgeModelId: body.judgeModelId,
      });
      rationale = verdict.rationale;
      newVotes = [advance(bracket, body.matchId, verdict.winner).vote];
    }

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
      rationale,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Judge failed' },
      { status: 400 },
    );
  }
}
