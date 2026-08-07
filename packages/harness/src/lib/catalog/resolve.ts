import { EVAL_MODELS, getModelById, type ModelRef } from '../../config/models';
import {
  canonicalIdForRef,
  normalizeModelId,
  parseCanonicalModelId,
  sourceForProvider,
  type ModelSource,
} from './model-id';
import {
  findOpenRouterEntry,
  getOpenRouterCatalog,
  OR_ID_PREFIX,
  type OpenRouterCatalogEntry,
} from './openrouter';

function stripPrivate(e: OpenRouterCatalogEntry): ModelRef & { evalEligible: boolean } {
  return {
    id: e.id,
    label: e.label,
    providerId: e.providerId,
    modelId: e.modelId,
    relativeCostWeight: e.relativeCostWeight,
    tier: e.tier,
    evalEligible: e.evalEligible,
  };
}

/** A model resolved to something callable, tagged with where it came from. */
export interface ResolvedModel extends ModelRef {
  canonicalId: string;
  source: ModelSource;
  evalEligible?: boolean;
}

function toResolved(ref: ModelRef & { evalEligible?: boolean }): ResolvedModel {
  return {
    ...ref,
    canonicalId: canonicalIdForRef(ref),
    source: sourceForProvider(ref.providerId),
  };
}

/**
 * Resolve any model id — curated, canonical, `or/<slug>`, or a bare
 * OpenRouter slug — into a callable reference.
 *
 * Self-hosted vLLM rows resolve from the curated catalog without touching the
 * network, so Compare can rank a local deploy next to a frontier API model.
 */
export async function resolveModel(id: string): Promise<ResolvedModel | undefined> {
  const curatedDirect = getModelById(id);
  if (curatedDirect) return toResolved({ ...curatedDirect, evalEligible: true });

  const canonical = normalizeModelId(id);
  const curatedByCanonical = EVAL_MODELS.find((m) => canonicalIdForRef(m) === canonical);
  if (curatedByCanonical) return toResolved({ ...curatedByCanonical, evalEligible: true });

  const parsed = parseCanonicalModelId(canonical);

  // Non-OpenRouter providers are dispatchable straight from the id.
  if (parsed && parsed.providerId !== 'openrouter') {
    return toResolved({
      id: canonical,
      label: parsed.modelId,
      providerId: parsed.providerId,
      modelId: parsed.modelId,
      relativeCostWeight: 100,
      evalEligible: true,
    });
  }

  const { entries } = await getOpenRouterCatalog();
  const lookup = parsed ? parsed.modelId : id;
  const found = findOpenRouterEntry(entries, lookup);
  return found ? toResolved(stripPrivate(found)) : undefined;
}

/** Back-compat alias — prefer `resolveModel`. */
export const resolveEvalModel = resolveModel;

export async function resolveEvalModels(ids: string[]): Promise<ModelRef[]> {
  const out: ModelRef[] = [];
  for (const id of ids) {
    const m = await resolveModel(id);
    if (!m) throw new Error(`Unknown model id: ${id}`);
    if (m.evalEligible === false) {
      throw new Error(
        `Model ${id} is not chat-eval eligible (image/video/audio/embeddings/…). Pick a text chat model.`,
      );
    }
    out.push(m);
  }
  return out;
}

export function listCuratedModels(): ModelRef[] {
  return EVAL_MODELS;
}

export { OR_ID_PREFIX };
