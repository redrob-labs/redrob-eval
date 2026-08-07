import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readArtifacts, readRunMeta, resolveRunFile } from '@/lib/image-eval';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ runId: string }> };

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/**
 * GET /api/image/runs/[runId]?file=… — the bytes of one generated image, or the
 * run's metadata. Vote cards in Compare load images through this route.
 */
export async function GET(request: Request, context: Ctx) {
  const { runId } = await context.params;
  const url = new URL(request.url);
  const file = url.searchParams.get('file');

  try {
    if (file) {
      const abs = resolveRunFile(runId, file);
      const bytes = await fs.readFile(abs);
      const ext = path.extname(abs).toLowerCase();
      return new Response(new Uint8Array(bytes), {
        headers: {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Cache-Control': 'private, max-age=3600',
        },
      });
    }

    return Response.json({
      meta: await readRunMeta(runId),
      artifacts: await readArtifacts(runId),
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Failed to load run' },
      { status: 404 },
    );
  }
}
