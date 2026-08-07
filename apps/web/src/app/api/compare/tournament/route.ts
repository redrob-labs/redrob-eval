import { NextResponse } from 'next/server';
import {
  aggregateTournament,
  createBracket,
  listTournaments,
  makeTournamentRunId,
  writeTournament,
  type Bracket,
  type Competitor,
  type TournamentMeta,
} from '@redrob/harness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type CreateBody = {
  sourceRunId: string;
  modality?: 'text' | 'image';
  prompts: Array<{ id: string; text: string }>;
  /** One entry per model, each holding that model's answer to every prompt. */
  answers: Array<{
    modelId: string;
    label: string;
    byPromptId: Record<string, { answer: string; error?: string }>;
  }>;
};

/** GET /api/compare/tournament — list saved tournaments. */
export async function GET() {
  return NextResponse.json({ tournaments: await listTournaments() });
}

/**
 * POST /api/compare/tournament — build one bracket per prompt from a finished
 * eval run's answers and persist it under eval/tournaments/.
 */
export async function POST(request: Request) {
  let body: CreateBody;
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.sourceRunId) {
    return NextResponse.json({ error: 'Provide sourceRunId' }, { status: 400 });
  }
  if (!Array.isArray(body.prompts) || body.prompts.length === 0) {
    return NextResponse.json({ error: 'Provide at least one prompt' }, { status: 400 });
  }
  if (!Array.isArray(body.answers) || body.answers.length < 2) {
    return NextResponse.json(
      { error: 'A tournament needs answers from at least two models' },
      { status: 400 },
    );
  }

  const brackets: Bracket[] = body.prompts.map((prompt) => {
    const competitors: Competitor[] = body.answers
      .map((model): Competitor | null => {
        const cell = model.byPromptId[prompt.id];
        if (!cell) return null;
        return {
          modelId: model.modelId,
          label: model.label,
          answer: cell.answer,
          error: cell.error,
        };
      })
      .filter((c): c is Competitor => c != null);

    return createBracket({
      promptId: prompt.id,
      promptText: prompt.text,
      competitors,
    });
  });

  const meta: TournamentMeta = {
    runId: makeTournamentRunId(body.sourceRunId),
    sourceRunId: body.sourceRunId,
    modality: body.modality ?? 'text',
    modelIds: body.answers.map((a) => a.modelId),
    promptIds: body.prompts.map((p) => p.id),
    createdAt: new Date().toISOString(),
    finishedAt: null,
  };

  await writeTournament({ meta, brackets, votes: [] });

  return NextResponse.json({
    meta,
    brackets,
    votes: [],
    aggregate: aggregateTournament({ brackets, votes: [] }),
  });
}
