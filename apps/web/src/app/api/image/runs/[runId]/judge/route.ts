import {
  applyAutoJudgeToRating,
  judgePreference,
} from '@/lib/image-eval/judge';
import {
  ensureRunRatings,
  loadSuite,
  readArtifacts,
  readRatings,
  readRunMeta,
  writeRatings,
  writeRunMeta,
} from '@/lib/image-eval';
import { resolveEvalModel } from '@redrob/harness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type Ctx = { params: Promise<{ runId: string }> };

/**
 * POST /api/image/runs/[runId]/judge — (re)run vision LLM auto-judge.
 * Body: { judgeModelId?: string, overwriteHuman?: boolean }
 */
export async function POST(request: Request, context: Ctx) {
  const { runId } = await context.params;
  let body: { judgeModelId?: string; overwriteHuman?: boolean } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // empty body ok
  }

  try {
    const meta = await readRunMeta(runId);
    const suite = await loadSuite(meta.suiteId);
    if (!suite) {
      return Response.json({ error: 'Suite missing' }, { status: 404 });
    }

    const judgeId = body.judgeModelId?.trim() || meta.judgeModelId || 'or/openai/gpt-4o';
    const resolved = await resolveEvalModel(judgeId);
    if (!resolved) {
      return Response.json({ error: `Unknown judge model: ${judgeId}` }, { status: 400 });
    }
    const openrouterId = resolved.id.startsWith('or/')
      ? resolved.id.slice(3)
      : resolved.modelId;

    const artifacts = await readArtifacts(runId);
    let ratings = ensureRunRatings({
      ratings: await readRatings(runId),
      suite,
      modelIds: meta.modelIds,
    });

    for (const prompt of suite.prompts) {
      if (!meta.promptIds.includes(prompt.id)) continue;
      const candidates = artifacts
        .filter((a) => a.promptId === prompt.id && a.relativePath && !a.error)
        .map((a) => ({ modelId: a.modelId, relativePath: a.relativePath }));
      if (!candidates.length) continue;

      const auto = await judgePreference({
        judgeOpenrouterId: openrouterId,
        prompt: prompt.prompt,
        candidates,
        runId,
      });

      const idx = ratings.findIndex((r) => r.prompt_id === prompt.id);
      if (idx < 0) continue;

      if (body.overwriteHuman) {
        ratings[idx] = {
          ...ratings[idx],
          winner: auto.winner,
          notes: auto.rationale,
          source: 'auto',
          auto: {
            winner: auto.winner,
            rationale: auto.rationale,
            scores: auto.scores,
          },
        };
      } else {
        ratings[idx] = applyAutoJudgeToRating(ratings[idx], auto);
      }
    }

    await writeRatings(runId, ratings);
    meta.autoJudge = true;
    meta.judgeModelId = judgeId;
    await writeRunMeta(runId, meta);

    return Response.json({ ok: true, ratings, meta });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Judge failed' },
      { status: 500 },
    );
  }
}
