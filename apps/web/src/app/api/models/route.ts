import { NextResponse } from 'next/server';
import { EVAL_MODELS } from '@redrob/harness';
import {
  getOpenRouterCatalog,
  OR_MODALITIES,
  toPublicModel,
  type OrModality,
} from '@redrob/harness';
import { listProviders } from '@redrob/harness';

export const runtime = 'nodejs';

type Public = {
  id: string;
  label: string;
  providerId: string;
  modelId: string;
  relativeCostWeight: number;
  tier: 'small' | 'large' | null;
  contextLength: number | null;
  created: number | null;
  author: string | null;
  modalities: OrModality[] | string[];
  evalEligible: boolean;
  imageGenEligible?: boolean;
  description: string | null;
  source: 'curated' | 'openrouter';
  callable: boolean;
};

/**
 * GET /api/models
 * Data source: OpenRouter https://openrouter.ai/api/v1/models?output_modalities=…
 * plus curated entries from packages/harness/src/config/models.ts
 *
 * ?source=curated|openrouter|all
 * ?modality=all|text|image|embeddings|audio|video|speech|transcription|rerank
 * ?q=search&sort=newest|name|weight
 * ?evalOnly=1 — only chat-eval-eligible models
 * ?limit=&offset=&refresh=1&tier=small|large
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const source = searchParams.get('source') ?? 'openrouter';
  const q = (searchParams.get('q') ?? '').trim().toLowerCase();
  const modality = (searchParams.get('modality') ?? 'all') as OrModality | 'all';
  const tier = searchParams.get('tier');
  const sort = searchParams.get('sort') ?? 'newest';
  const evalOnly = searchParams.get('evalOnly') === '1';
  const refresh = searchParams.get('refresh') === '1';
  const limit = Math.min(200, Math.max(1, Number(searchParams.get('limit') ?? 40) || 40));
  const offset = Math.max(0, Number(searchParams.get('offset') ?? 0) || 0);

  const providers = listProviders();
  const openrouterConfigured = Boolean(
    providers.find((p) => p.id === 'openrouter')?.configured,
  );

  const curated: Public[] = EVAL_MODELS.map((m) => {
    const provider = providers.find((p) => p.id === m.providerId);
    return {
      id: m.id,
      label: m.label,
      providerId: m.providerId,
      modelId: m.modelId,
      relativeCostWeight: m.relativeCostWeight,
      tier: m.tier ?? null,
      contextLength: null,
      created: null,
      author: m.providerId,
      modalities: ['text'],
      evalEligible: true,
      imageGenEligible: false,
      description: null,
      source: 'curated' as const,
      callable: Boolean(provider?.configured),
    };
  });

  let openrouter: Public[] = [];
  let fetchedAt: number | null = null;
  let fromCache = false;
  let orError: string | null = null;
  let modalityCounts: Record<string, number> = Object.fromEntries(
    OR_MODALITIES.map((m) => [m, 0]),
  );

  if (source === 'openrouter' || source === 'all') {
    try {
      const catalog = await getOpenRouterCatalog({ forceRefresh: refresh });
      fetchedAt = catalog.fetchedAt;
      fromCache = catalog.fromCache;
      modalityCounts = catalog.modalityCounts;
      openrouter = catalog.entries.map((e) => {
        const pub = toPublicModel(e);
        return {
          ...pub,
          callable:
            openrouterConfigured && (pub.evalEligible || pub.imageGenEligible),
          source: 'openrouter' as const,
        };
      });
    } catch (e) {
      orError = e instanceof Error ? e.message : 'Failed to load OpenRouter catalog';
      if (source === 'openrouter') {
        return NextResponse.json({ error: orError }, { status: 502 });
      }
    }
  }

  let models: Public[] =
    source === 'curated'
      ? curated
      : source === 'openrouter'
        ? openrouter
        : [
            ...curated,
            ...openrouter.filter(
              (o) =>
                !curated.some(
                  (c) => c.modelId === o.modelId && c.providerId === 'openrouter',
                ),
            ),
          ];

  if (modality !== 'all' && OR_MODALITIES.includes(modality as OrModality)) {
    models = models.filter((m) => m.modalities.includes(modality));
  }
  if (evalOnly) {
    models = models.filter((m) => m.evalEligible);
  }
  if (searchParams.get('imageOnly') === '1') {
    models = models.filter((m) => m.imageGenEligible || m.modalities.includes('image'));
  }
  if (q) {
    models = models.filter(
      (m) =>
        m.label.toLowerCase().includes(q) ||
        m.modelId.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        (m.author ?? '').toLowerCase().includes(q),
    );
  }
  if (tier === 'small' || tier === 'large') {
    models = models.filter((m) => m.tier === tier);
  }

  if (sort === 'name') {
    models = models.slice().sort((a, b) => a.label.localeCompare(b.label));
  } else if (sort === 'weight') {
    models = models.slice().sort((a, b) => b.relativeCostWeight - a.relativeCostWeight);
  } else {
    models = models
      .slice()
      .sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.label.localeCompare(b.label));
  }

  const total = models.length;
  const page = models.slice(offset, offset + limit);

  return NextResponse.json({
    dataSource: 'https://openrouter.ai/api/v1/models?output_modalities=…',
    total,
    offset,
    limit,
    fetchedAt,
    fromCache,
    openrouterConfigured,
    openrouterError: orError,
    modalityCounts: {
      all: openrouter.length || modalityCounts.text,
      ...modalityCounts,
    },
    models: page,
  });
}
