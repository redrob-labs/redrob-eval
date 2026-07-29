import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelRef } from '../../config/models';

const OR_API = 'https://openrouter.ai/api/v1/models';
const CACHE_PATH = join(process.cwd(), '.cache', 'openrouter-models-v2.json');
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Catalog id prefix for dynamic OpenRouter entries: `or/<openrouter-model-id>` */
export const OR_ID_PREFIX = 'or/';

/**
 * OpenRouter website modality tabs map to `?output_modalities=` on
 * https://openrouter.ai/api/v1/models
 */
export const OR_MODALITIES = [
  'text',
  'image',
  'embeddings',
  'audio',
  'video',
  'speech',
  'transcription',
  'rerank',
] as const;

export type OrModality = (typeof OR_MODALITIES)[number];

export interface OpenRouterCatalogEntry extends ModelRef {
  openrouterId: string;
  contextLength: number | null;
  created: number | null;
  description: string | null;
  author: string;
  modalities: OrModality[];
  /** True when usable with chat completions for our text eval suites */
  evalEligible: boolean;
  /** True when usable for OpenRouter image generation (output includes image) */
  imageGenEligible?: boolean;
}

type CacheFile = {
  fetchedAt: number;
  entries: OpenRouterCatalogEntry[];
  modalityCounts: Record<OrModality, number>;
};

type OrApiModel = {
  id: string;
  name?: string;
  description?: string | null;
  context_length?: number | null;
  created?: number | null;
  expiration_date?: string | null;
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
  };
  pricing?: {
    prompt?: string;
    completion?: string;
  };
};

function ensureCacheDir(): void {
  const dir = join(process.cwd(), '.cache');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Project forbid list: Krea + obvious NSFW endpoints. */
function isBlocked(m: OrApiModel): boolean {
  const id = m.id.toLowerCase();
  const name = (m.name ?? '').toLowerCase();
  const desc = (m.description ?? '').toLowerCase();
  if (id.startsWith('krea/') || id.includes('/krea')) return true;
  if (id.includes('nsfw') || name.includes('nsfw') || desc.includes('nsfw')) return true;
  return false;
}

function isExpired(m: OrApiModel): boolean {
  if (!m.expiration_date) return false;
  const exp = Date.parse(m.expiration_date);
  return Number.isFinite(exp) && exp < Date.now();
}

function authorFromId(id: string): string {
  const i = id.indexOf('/');
  return i > 0 ? id.slice(0, i) : id;
}

function blendedRate(m: OrApiModel): number {
  const prompt = Number(m.pricing?.prompt ?? 0);
  const completion = Number(m.pricing?.completion ?? 0);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return 0;
  return prompt * 0.35 + completion * 0.65;
}

function toRelativeWeight(rate: number, refRate: number): number {
  if (rate <= 0) return 1;
  const ref = refRate > 0 ? refRate : rate;
  return Math.max(1, Math.min(500, Math.round((rate / ref) * 100)));
}

function inferTier(weight: number): 'small' | 'large' {
  return weight >= 45 ? 'large' : 'small';
}

/**
 * Chat-eval eligible: must emit text and not be a dedicated
 * embedding / rerank / speech / transcription / pure-image endpoint.
 */
function computeEvalEligible(modalities: OrModality[], m: OrApiModel): boolean {
  if (!modalities.includes('text')) return false;
  const onlySpecial =
    modalities.length > 0 &&
    modalities.every((x) =>
      ['embeddings', 'rerank', 'speech', 'transcription', 'image', 'video', 'audio'].includes(x),
    );
  if (onlySpecial && !modalities.includes('text')) return false;

  // Pure image generators (no text out)
  const outs = m.architecture?.output_modalities ?? [];
  if (outs.length > 0 && !outs.includes('text')) return false;

  // Dedicated non-chat families still tagged text by OR sometimes
  if (modalities.includes('embeddings') && modalities.length === 1) return false;
  if (modalities.includes('rerank') && modalities.length === 1) return false;
  if (modalities.includes('transcription') && !modalities.includes('text')) return false;

  const modality = m.architecture?.modality ?? '';
  if (modality.includes('->') && !modality.split('->')[1]?.includes('text')) return false;

  if (m.id === 'openrouter/auto' || m.id.startsWith('openrouter/auto')) return false;
  return true;
}

async function fetchModality(mod: OrModality, headers: Record<string, string>): Promise<OrApiModel[]> {
  const url = `${OR_API}?output_modalities=${encodeURIComponent(mod)}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`OpenRouter models (${mod}) HTTP ${res.status}`);
  }
  const json = (await res.json()) as { data?: OrApiModel[] };
  return json.data ?? [];
}

function mapMerged(
  byId: Map<string, { raw: OrApiModel; modalities: Set<OrModality> }>,
): OpenRouterCatalogEntry[] {
  const raws = Array.from(byId.values()).map((v) => v.raw);
  const gpt4o = raws.find((m) => m.id === 'openai/gpt-4o');
  const refRate = gpt4o
    ? blendedRate(gpt4o)
    : Math.max(...raws.map(blendedRate), 1e-12);

  const entries: OpenRouterCatalogEntry[] = [];
  for (const { raw, modalities } of byId.values()) {
    if (isBlocked(raw) || isExpired(raw)) continue;
    const mods = OR_MODALITIES.filter((m) => modalities.has(m));
    const rate = blendedRate(raw);
    const relativeCostWeight = toRelativeWeight(rate, refRate);
    entries.push({
      id: `${OR_ID_PREFIX}${raw.id}`,
      label: raw.name?.trim() || raw.id,
      providerId: 'openrouter',
      modelId: raw.id,
      relativeCostWeight,
      tier: inferTier(relativeCostWeight),
      openrouterId: raw.id,
      contextLength: raw.context_length ?? null,
      created: raw.created ?? null,
      description: raw.description ?? null,
      author: authorFromId(raw.id),
      modalities: mods.length ? mods : (['text'] as OrModality[]),
      evalEligible: computeEvalEligible(mods, raw),
      imageGenEligible: mods.includes('image'),
    });
  }

  return entries.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
}

async function fetchFromOpenRouter(): Promise<{
  entries: OpenRouterCatalogEntry[];
  modalityCounts: Record<OrModality, number>;
}> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (key) headers.Authorization = `Bearer ${key}`;

  const byId = new Map<string, { raw: OrApiModel; modalities: Set<OrModality> }>();
  const modalityCounts = Object.fromEntries(OR_MODALITIES.map((m) => [m, 0])) as Record<
    OrModality,
    number
  >;

  // Parallel fetch per modality (same pattern as openrouter.ai/models tabs)
  const results = await Promise.all(
    OR_MODALITIES.map(async (mod) => ({ mod, rows: await fetchModality(mod, headers) })),
  );

  for (const { mod, rows } of results) {
    let count = 0;
    for (const raw of rows) {
      if (isBlocked(raw) || isExpired(raw)) continue;
      count += 1;
      const existing = byId.get(raw.id);
      if (existing) {
        existing.modalities.add(mod);
      } else {
        byId.set(raw.id, { raw, modalities: new Set([mod]) });
      }
    }
    modalityCounts[mod] = count;
  }

  return { entries: mapMerged(byId), modalityCounts };
}

function readCache(): CacheFile | null {
  if (!existsSync(CACHE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as CacheFile;
  } catch {
    return null;
  }
}

function writeCache(
  entries: OpenRouterCatalogEntry[],
  modalityCounts: Record<OrModality, number>,
): void {
  ensureCacheDir();
  // Persist relative weights only — never absolute provider rates.
  const payload: CacheFile = { fetchedAt: Date.now(), entries, modalityCounts };
  writeFileSync(CACHE_PATH, JSON.stringify(payload), 'utf8');
}

export async function getOpenRouterCatalog(options?: {
  forceRefresh?: boolean;
}): Promise<{
  entries: OpenRouterCatalogEntry[];
  fromCache: boolean;
  fetchedAt: number;
  modalityCounts: Record<OrModality, number>;
}> {
  const cached = readCache();
  const fresh =
    cached &&
    !options?.forceRefresh &&
    Date.now() - cached.fetchedAt < CACHE_TTL_MS &&
    cached.entries.length > 0 &&
    cached.modalityCounts;

  if (fresh && cached) {
    return {
      entries: cached.entries,
      fromCache: true,
      fetchedAt: cached.fetchedAt,
      modalityCounts: cached.modalityCounts,
    };
  }

  try {
    const { entries, modalityCounts } = await fetchFromOpenRouter();
    writeCache(entries, modalityCounts);
    return { entries, fromCache: false, fetchedAt: Date.now(), modalityCounts };
  } catch (err) {
    if (cached?.entries?.length) {
      return {
        entries: cached.entries,
        fromCache: true,
        fetchedAt: cached.fetchedAt,
        modalityCounts:
          cached.modalityCounts ??
          (Object.fromEntries(OR_MODALITIES.map((m) => [m, 0])) as Record<OrModality, number>),
      };
    }
    throw err;
  }
}

export function findOpenRouterEntry(
  entries: OpenRouterCatalogEntry[],
  idOrSlug: string,
): OpenRouterCatalogEntry | undefined {
  if (idOrSlug.startsWith(OR_ID_PREFIX)) {
    return entries.find((e) => e.id === idOrSlug);
  }
  return (
    entries.find((e) => e.openrouterId === idOrSlug) ||
    entries.find((e) => e.id === `${OR_ID_PREFIX}${idOrSlug}`)
  );
}

export function catalogFingerprint(entries: OpenRouterCatalogEntry[]): string {
  const ids = entries.map((e) => e.id).join('|');
  return createHash('sha256').update(ids).digest('hex').slice(0, 12);
}

/** Public list shape — no absolute prices. */
export function toPublicModel(e: OpenRouterCatalogEntry) {
  const imageGenEligible =
    e.imageGenEligible ?? e.modalities?.includes('image') ?? false;
  return {
    id: e.id,
    label: e.label,
    providerId: e.providerId,
    modelId: e.modelId,
    relativeCostWeight: e.relativeCostWeight,
    tier: e.tier ?? null,
    contextLength: e.contextLength,
    created: e.created,
    author: e.author,
    modalities: e.modalities,
    evalEligible: e.evalEligible,
    imageGenEligible,
    description: e.description
      ? e.description.length > 220
        ? `${e.description.slice(0, 220)}…`
        : e.description
      : null,
    source: 'openrouter' as const,
  };
}
