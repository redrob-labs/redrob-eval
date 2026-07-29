import { EVAL_MODELS, getModelById, type ModelRef } from '../../config/models';
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

/**
 * Resolve a catalog id from curated config or the OpenRouter dynamic catalog.
 * Accepts: curated id, `or/<slug>`, or raw OpenRouter slug (`openai/gpt-4o`).
 */
export async function resolveEvalModel(
  id: string,
): Promise<(ModelRef & { evalEligible?: boolean }) | undefined> {
  const curated = getModelById(id);
  if (curated) return { ...curated, evalEligible: true };

  const { entries } = await getOpenRouterCatalog();
  const found = findOpenRouterEntry(entries, id);
  return found ? stripPrivate(found) : undefined;
}

export async function resolveEvalModels(ids: string[]): Promise<ModelRef[]> {
  const out: ModelRef[] = [];
  for (const id of ids) {
    const m = await resolveEvalModel(id);
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
