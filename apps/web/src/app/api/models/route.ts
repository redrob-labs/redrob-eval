import { NextResponse } from 'next/server';
import { EVAL_MODELS } from '@redrob/harness';
import {
  canonicalIdForRef,
  getLiveSelfHostedModel,
  getLiveSelfHostedSlots,
  getOpenRouterCatalog,
  selfHostedSlotRow,
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
    precision: string;
    license: string;
    hfRepoId: string;
    maxModelLen: number;
    /** What the endpoint answered when asked, as opposed to what Deploy planned. */
    live?: {
      reachable: boolean;
      /** True when the row above was rewritten from the endpoint's own answer. */
      synced: boolean;
      baseUrl: string;
      error: string | null;
    };
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

  const curated: Public[] = [];
  const curatedSeen = new Set<string>();
  for (const m of EVAL_MODELS) {
    const id = canonicalIdForRef(m);
    if (curatedSeen.has(id)) continue;
    curatedSeen.add(id);
    const provider = providers.find((p) => p.id === m.providerId);
    curated.push({
      id,
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
            precision: m.selfHosted.precision,
            license: m.selfHosted.license,
            hfRepoId: m.selfHosted.hfRepoId,
            maxModelLen: m.selfHosted.maxModelLen,
          }
        : null,
    });
  }

  // The vLLM row is built from the deploy default, which is a plan, not a fact.
  // Ask the endpoint what it is actually serving before the picker names it,
  // otherwise swapping the model on /deploy silently mislabels every result.
  const wantsSelfHosted =
    source === 'curated' || source === 'all' || source === 'selfhosted';
  if (wantsSelfHosted && curated.some((c) => c.source === 'selfhosted')) {
    // Every slot that answered gets its own row. The single placeholder row only
    // survives when nothing answered, so the picker can still show why.
    const slots = await getLiveSelfHostedSlots({ forceRefresh: refresh });
    if (slots.length > 0) {
      const placeholderIndex = curated.findIndex((c) => c.source === 'selfhosted');
      const template = curated[placeholderIndex]!;
      const slotRows: Public[] = slots.map((slot) => {
        const ref = selfHostedSlotRow({
          slot: slot.slot,
          servedModelName: slot.servedModelName,
          hfRepoId: slot.hfRepoId!,
          maxModelLen: slot.maxModelLen,
        });
        return {
          ...template,
          id: canonicalIdForRef(ref),
          label: `${ref.label} · slot ${slot.slot}`,
          modelId: ref.modelId,
          tier: ref.tier ?? null,
          contextLength: ref.selfHosted?.maxModelLen ?? null,
          callable: true,
          selfHosted: {
            precision: ref.selfHosted!.precision,
            license: ref.selfHosted!.license,
            hfRepoId: ref.selfHosted!.hfRepoId,
            maxModelLen: ref.selfHosted!.maxModelLen,
            live: {
              reachable: true,
              synced: true,
              baseUrl: slot.baseUrl,
              error: null,
            },
          },
        };
      });
      // Drop every static self-hosted placeholder and use the live rows instead.
      for (let i = curated.length - 1; i >= 0; i -= 1) {
        if (curated[i]!.source === 'selfhosted') curated.splice(i, 1);
      }
      curated.splice(placeholderIndex, 0, ...slotRows);
    } else {
      // Nothing answered. Keep the single placeholder and describe the failure on
      // it: an unreachable endpoint must not be selectable, because a key with
      // nothing behind it used to look like a model scoring zero.
      const live = await getLiveSelfHostedModel({ forceRefresh: refresh });
      for (const row of curated) {
        if (row.source !== 'selfhosted' || !row.selfHosted) continue;
        const synced = live.reachable && Boolean(live.hfRepoId);
        if (synced) {
          row.label = `Self-hosted: ${live.label ?? live.hfRepoId}`;
          row.selfHosted.hfRepoId = live.hfRepoId!;
          if (live.maxModelLen) {
            row.selfHosted.maxModelLen = live.maxModelLen;
            row.contextLength = live.maxModelLen;
          }
        }
        row.callable = row.callable && live.reachable;
        row.selfHosted.live = {
          reachable: live.reachable,
          synced,
          baseUrl: live.baseUrl,
          error: live.error,
        };
      }
    }
  }

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

  // Curated rows carry no `created`, so the newest-first sort buried them under
  // hundreds of OpenRouter entries and the first page dropped them entirely:
  // your own endpoint was findable only by searching for it. The picker already
  // renders self-hosted and frontier as the first two groups, so pin them to
  // match. Within each side the chosen sort still decides the order.
  const SOURCE_RANK: Record<ModelSource, number> = {
    selfhosted: 0,
    frontier: 1,
    openrouter: 2,
  };
  models = models
    .slice()
    .sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source]);

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
