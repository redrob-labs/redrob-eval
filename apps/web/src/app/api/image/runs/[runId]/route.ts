import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  ensureRunRatings,
  listRunImagePaths,
  loadSuite,
  readArtifacts,
  readRatings,
  readRunMeta,
  resolveRunFile,
  writeRatings,
  type ImagePreferenceRating,
} from '@/lib/image-eval';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ runId: string }> };

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/** GET /api/image/runs/[runId]?file=… — run payload or file bytes */
export async function GET(request: Request, context: Ctx) {
  const { runId } = await context.params;
  const url = new URL(request.url);
  const file = url.searchParams.get('file');

  try {
    if (file) {
      const abs = resolveRunFile(runId, file);
      const bytes = await fs.readFile(abs);
      const ext = path.extname(abs).toLowerCase();
      return new Response(bytes, {
        headers: {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Cache-Control': 'private, max-age=3600',
        },
      });
    }

    const meta = await readRunMeta(runId);
    const suite = await loadSuite(meta.suiteId);
    const ratings = suite
      ? ensureRunRatings({
          ratings: await readRatings(runId),
          suite,
          modelIds: meta.modelIds,
        })
      : await readRatings(runId);
    const artifacts = await readArtifacts(runId);
    const images = await listRunImagePaths(runId);

    return Response.json({
      meta,
      suite,
      ratings,
      artifacts,
      images,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Failed to load run' },
      { status: 404 },
    );
  }
}

/** PATCH /api/image/runs/[runId] — persist human ratings */
export async function PATCH(request: Request, context: Ctx) {
  const { runId } = await context.params;
  let body: { ratings?: ImagePreferenceRating[] };
  try {
    body = (await request.json()) as { ratings?: ImagePreferenceRating[] };
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!Array.isArray(body.ratings)) {
    return Response.json({ error: 'Provide ratings array' }, { status: 400 });
  }

  try {
    await readRunMeta(runId);
    await writeRatings(runId, body.ratings);
    return Response.json({ ok: true, count: body.ratings.length });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Save failed' },
      { status: 400 },
    );
  }
}
