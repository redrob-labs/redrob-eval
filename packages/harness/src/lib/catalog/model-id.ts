import { EVAL_MODELS, type ModelRef, type ProviderId } from '../../config/models';

/**
 * One id space for every model, whatever its source.
 *
 * Compare treats a frontier API model, an OpenRouter model and a self-hosted
 * vLLM endpoint as interchangeable, so they need a single identifier. The
 * canonical form is `<providerId>/<provider-native modelId>`:
 *
 *   openrouter/openai/gpt-4o
 *   openai/gpt-4o-mini
 *   anthropic/claude-haiku-4-5-20251001
 *   vllm/redrob
 *
 * Historic ids (`or-gpt-4o`, `or/openai/gpt-4o`, `vllm-gemma4-e4b`) still
 * resolve — see `normalizeModelId`. Nothing outside this module should parse
 * an id by hand.
 */

/** Where a model row came from, for grouping in the picker. */
export type ModelSource = 'openrouter' | 'frontier' | 'selfhosted';

export const PROVIDER_IDS: ProviderId[] = [
  'openrouter',
  'openai',
  'anthropic',
  'google',
  'together',
  'fireworks',
  'vllm',
];

export function canonicalModelId(providerId: ProviderId, modelId: string): string {
  return `${providerId}/${modelId}`;
}

export function canonicalIdForRef(ref: Pick<ModelRef, 'providerId' | 'modelId'>): string {
  return canonicalModelId(ref.providerId, ref.modelId);
}

export function sourceForProvider(providerId: ProviderId): ModelSource {
  if (providerId === 'vllm') return 'selfhosted';
  if (providerId === 'openrouter') return 'openrouter';
  return 'frontier';
}

/** Split a canonical id back into its parts, or null if it is not canonical. */
export function parseCanonicalModelId(
  id: string,
): { providerId: ProviderId; modelId: string } | null {
  const slash = id.indexOf('/');
  if (slash <= 0) return null;
  const head = id.slice(0, slash);
  const rest = id.slice(slash + 1);
  if (!rest) return null;
  if (!(PROVIDER_IDS as string[]).includes(head)) return null;
  return { providerId: head as ProviderId, modelId: rest };
}

/**
 * Legacy id -> canonical id, built from the curated catalog so every historic
 * id (`or-gpt-4o`, `vllm-gemma4-e4b`, `openai-gpt-4o-mini`) keeps working.
 */
let aliasCache: Map<string, string> | null = null;

function aliasTable(): Map<string, string> {
  if (aliasCache) return aliasCache;
  const table = new Map<string, string>();
  for (const ref of EVAL_MODELS) {
    table.set(ref.id, canonicalIdForRef(ref));
  }
  aliasCache = table;
  return table;
}

/**
 * Accept any id this codebase has ever used and return the canonical form.
 *
 * Handles, in order:
 *   1. curated catalog ids            or-gpt-4o, vllm-gemma4-e4b
 *   2. already canonical              openrouter/openai/gpt-4o
 *   3. the old OpenRouter prefix      or/openai/gpt-4o
 *   4. a bare OpenRouter slug         openai/gpt-4o
 *
 * A bare slug is assumed to be OpenRouter because that is the only source
 * whose native ids contain a slash.
 */
export function normalizeModelId(rawId: string): string {
  const id = rawId.trim();
  if (!id) return id;

  const alias = aliasTable().get(id);
  if (alias) return alias;

  if (parseCanonicalModelId(id)) return id;

  if (id.startsWith('or/')) {
    return canonicalModelId('openrouter', id.slice(3));
  }

  if (id.includes('/')) {
    return canonicalModelId('openrouter', id);
  }

  return id;
}

/** True when two ids refer to the same model, whatever form each is in. */
export function sameModel(a: string, b: string): boolean {
  return normalizeModelId(a) === normalizeModelId(b);
}
