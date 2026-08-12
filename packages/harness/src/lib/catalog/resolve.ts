import {
  EVAL_MODELS,
  getModelById,
  selfHostedSlotId,
  selfHostedSlotRow,
  type ModelRef,
} from '../../config/models';
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
import { getLiveSelfHostedSlots, syncSelfHostedRef } from './self-hosted-live';

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
 * Match a deploy-slot id against the endpoints that are actually serving.
 *
 * Accepts the catalog id (`vllm-endpoint-s1`), the canonical id
 * (`vllm/redrob-s1`) and the bare served alias, so a saved run keeps resolving
 * whichever spelling it stored.
 */
async function resolveSelfHostedSlot(id: string): Promise<ModelRef | undefined> {
  const wanted = id.trim();
  if (!wanted || !/(^|\/|-)(vllm|redrob)/i.test(wanted)) return undefined;

  const slots = await getLiveSelfHostedSlots();
  if (slots.length === 0) return undefined;

  const hit = slots.find((s) => {
    const canonical = `vllm/${s.servedModelName}`;
    return (
      wanted === selfHostedSlotId(s.slot) ||
      wanted === canonical ||
      wanted === s.servedModelName
    );
  });
  if (!hit?.hfRepoId) return undefined;

  return selfHostedSlotRow({
    slot: hit.slot,
    servedModelName: hit.servedModelName,
    hfRepoId: hit.hfRepoId,
    maxModelLen: hit.maxModelLen,
  });
}

/**
 * Resolve any model id — curated, canonical, `or/<slug>`, or a bare
 * OpenRouter slug — into a callable reference.
 *
 * Self-hosted vLLM rows resolve from the curated catalog, then follow the live
 * endpoint: Deploy can swap the weights behind the alias, and a result labeled
 * with the model that used to be there is worse than no result. The probe is
 * memoized and never throws, so an endpoint that is off costs one timeout.
 */
export async function resolveModel(id: string): Promise<ResolvedModel | undefined> {
  // Deploy slots come before the curated lookup: they are the live fact, and
  // their ids (`vllm-endpoint-s1`, `vllm/redrob-s1`) are not in the static list.
  const slotRef = await resolveSelfHostedSlot(id);
  if (slotRef) return toResolved({ ...slotRef, evalEligible: true });

  const curatedDirect = getModelById(id);
  if (curatedDirect) {
    return toResolved(await syncSelfHostedRef({ ...curatedDirect, evalEligible: true }));
  }

  const canonical = normalizeModelId(id);
  const curatedByCanonical = EVAL_MODELS.find((m) => canonicalIdForRef(m) === canonical);
  if (curatedByCanonical) {
    return toResolved(await syncSelfHostedRef({ ...curatedByCanonical, evalEligible: true }));
  }

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
