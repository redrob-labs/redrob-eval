import { NextResponse } from 'next/server';
import { createRunStore, type RunFilter, type RunStatus } from '@redrob/harness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/analyze/runs — the registry, filtered.
 *
 * The same questions `yarn runs` answers, for a browser: what was run, of what
 * kind, in what state. Read-only.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const filter: RunFilter = { limit: Number(searchParams.get('limit') ?? '50') || 50 };
  const kind = searchParams.get('kind');
  if (kind) filter.kind = kind;
  const status = searchParams.get('status');
  if (status) filter.status = status as RunStatus;
  const tag = searchParams.get('tag');
  if (tag) filter.tags = tag.split(',').map((t) => t.trim()).filter(Boolean);
  const search = searchParams.get('search');
  if (search) filter.search = search;

  const store = await createRunStore();
  try {
    const [runs, total] = await Promise.all([
      store.list(filter),
      store.count({ ...filter, limit: undefined, offset: undefined }),
    ]);
    // The kinds present, so the UI can offer a real filter rather than a guess.
    const kinds = [...new Set((await store.list({ limit: 500 })).map((r) => r.kind))].sort();
    return NextResponse.json({ runs, total, kinds, driver: store.driver });
  } finally {
    await store.close();
  }
}
