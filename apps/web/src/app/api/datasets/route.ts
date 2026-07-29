import { NextResponse } from 'next/server';
import { getDatasetById } from '@redrob/harness';
import { HfDatasetError, loadDataset, previewDatasets } from '@redrob/harness';

export const runtime = 'nodejs';

/**
 * GET /api/datasets — list catalog
 * GET /api/datasets?id=gsm8k-main&limit=3 — load samples (cached under .cache/)
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return NextResponse.json({ datasets: previewDatasets() });
  }

  const ref = getDatasetById(id);
  if (!ref) {
    return NextResponse.json({ error: `Unknown dataset id: ${id}` }, { status: 400 });
  }

  const limitRaw = searchParams.get('limit');
  const seedRaw = searchParams.get('seed');
  const forceRefresh = searchParams.get('refresh') === '1';

  const maxSamples = limitRaw != null ? Number(limitRaw) : undefined;
  const seed = seedRaw != null ? Number(seedRaw) : undefined;

  if (maxSamples != null && (!Number.isFinite(maxSamples) || maxSamples < 1)) {
    return NextResponse.json({ error: 'limit must be a positive number' }, { status: 400 });
  }
  if (seed != null && !Number.isFinite(seed)) {
    return NextResponse.json({ error: 'seed must be a number' }, { status: 400 });
  }

  try {
    const loaded = await loadDataset(id, {
      maxSamples: maxSamples != null ? Math.min(Math.floor(maxSamples), ref.maxSamples) : undefined,
      seed,
      forceRefresh,
    });

    const previewLimit = Math.min(
      loaded.samples.length,
      maxSamples != null ? Math.floor(maxSamples) : 5,
    );

    return NextResponse.json({
      datasetId: loaded.datasetId,
      label: loaded.label,
      task: loaded.task,
      metric: loaded.metric,
      hfDataset: loaded.hfDataset,
      hfConfig: loaded.hfConfig,
      hfSplit: loaded.hfSplit,
      seed: loaded.seed,
      maxSamples: loaded.maxSamples,
      fromCache: loaded.fromCache,
      totalLoaded: loaded.samples.length,
      samples: loaded.samples.slice(0, previewLimit).map((s) => ({
        id: s.id,
        input: s.input.length > 400 ? `${s.input.slice(0, 400)}…` : s.input,
        gold: s.gold.length > 400 ? `${s.gold.slice(0, 400)}…` : s.gold,
      })),
    });
  } catch (error) {
    if (error instanceof HfDatasetError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status && error.status >= 400 ? error.status : 502 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Dataset load failed' },
      { status: 502 },
    );
  }
}

/**
 * POST /api/datasets — load with JSON body
 * { "id": "gsm8k-main", "limit": 5, "seed": 42, "refresh": false }
 */
export async function POST(request: Request) {
  let body: { id?: string; limit?: number; seed?: number; refresh?: boolean };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.id) {
    return NextResponse.json({ error: 'Provide id (dataset catalog id)' }, { status: 400 });
  }

  const url = new URL(request.url);
  url.searchParams.set('id', body.id);
  if (body.limit != null) url.searchParams.set('limit', String(body.limit));
  if (body.seed != null) url.searchParams.set('seed', String(body.seed));
  if (body.refresh) url.searchParams.set('refresh', '1');

  return GET(new Request(url.toString(), { method: 'GET' }));
}
