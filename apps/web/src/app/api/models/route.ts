import { NextResponse } from 'next/server';
import { EVAL_MODELS } from '@redrob/harness';
import {
  canonicalIdForRef,
  getOpenRouterCatalog,
  normalizeModelId,
  OR_MODALITIES,
  sourceForProvider,
  toPublicModel,
  type ModelSource,
  type OrModality,
} from '@redrob/harness';
import { listProviders } from '@redrob/harness';

export const runtime = 'nodejs';

type Public = {
  /** Canonical `<providerId>/<modelId>` — the same model has one id everywhere. */
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
  /** Grouping for the picker: where you get this model from. */
  source: ModelSource;
  callable: boolean;
  selfHosted?: {
    axis: 'S' | 'L';
    precision: string;
    license: string;
    hfRepoId: string;
    maxModelLen: number;
  } | null;
};

/**
 * GET /api/models
 * Data source: OpenRouter https://openrouter.ai/api/v1/models?output_modalities=…
 * plus curated entries from packages/harness/src/config/models.ts
 *
 * ?source=curated|openrouter|selfhosted|frontier|all
 * ?modality=all|text|image|embeddings|audio|video|speech|transcription|rerank
 * ?q=search&sort=newest|name|weight
 * ?evalOnly=1 — only chat-eval-eligible models
 * ?limit=&offset=&refresh=1&tier=small|large
 *
 * Ids are canonical (`<providerId>/<modelId>`) so Compare can mix a frontier
 * API model, an OpenRouter model and a self-hosted vLLM endpoint in one list.
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
      id: canonicalIdForRef(m),
      label: m.label,
      providerId: m.providerId,
      modelId: m.modelId,
      relativeCostWeight: m.relativeCostWeight,
      tier: m.tier ?? null,
      contextLength: m.selfHosted?.maxModelLen ?? null,
      created: null,
      author: m.providerId,
      modalities: ['text'],
      evalEligible: true,
      imageGenEligible: false,
      description: null,
      source: sourceForProvider(m.providerId),
      callable: Boolean(provider?.configured),
      selfHosted: m.selfHosted
        ? {
            axis: m.selfHosted.axis,
            precision: m.selfHosted.precision,
            license: m.selfHosted.license,
            hfRepoId: m.selfHosted.hfRepoId,
            maxModelLen: m.selfHosted.maxModelLen,
          }
        : null,
    };
  });

  let openrouter: Public[] = [];
  let fetchedAt: number | null = null;
  let fromCache = false;
  let orError: string | null = null;
  let modalityCounts: Record<string, number> = Object.fromEntries(
    OR_MODALITIES.map((m) => [m, 0]),
  );

  const wantsOpenRouter = source === 'openrouter' || source === 'all';
  if (wantsOpenRouter) {
    try {
      const catalog = await getOpenRouterCatalog({ forceRefresh: refresh });
      fetchedAt = catalog.fetchedAt;
      fromCache = catalog.fromCache;
      modalityCounts = catalog.modalityCounts;
      openrouter = catalog.entries.map((e) => {
        const pub = toPublicModel(e);
        return {
          ...pub,
          id: normalizeModelId(pub.id),
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

  // Canonical ids make dedupe exact — the curated row wins because it carries
  // the nicer label plus self-hosted metadata.
  const curatedIds = new Set(curated.map((c) => c.id));
  const merged: Public[] = [
    ...curated,
    ...openrouter.filter((o) => !curatedIds.has(o.id)),
  ];

  let models: Public[];
  if (source === 'curated') {
    models = curated;
  } else if (source === 'openrouter') {
    models = openrouter;
  } else if (source === 'selfhosted' || source === 'frontier') {
    models = curated.filter((c) => c.source === source);
  } else {
    models = merged;
  }

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
    sourceCounts: {
      selfhosted: merged.filter((m) => m.source === 'selfhosted').length,
      frontier: merged.filter((m) => m.source === 'frontier').length,
      openrouter: merged.filter((m) => m.source === 'openrouter').length,
    },
    models: page,
  });
}
