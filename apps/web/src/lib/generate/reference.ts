/**
 * Extract a single deterministic reference answer from a bound Generate
 * verifier.
 *
 * Not every verifier is a reference answer. A format constraint describes a
 * family of valid replies, so inventing one `gold` would turn valid alternatives
 * into failures. Exact and numeric verifiers do carry one expected value, and
 * those are the only forms this handoff claims to support.
 */
export type ReferenceMetric = 'accuracy' | 'gsm8k_exact';

export interface ReferenceAnswer {
  gold: string;
  metric: ReferenceMetric;
}

function fromOne(value: unknown): ReferenceAnswer | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const verifier = value as { type?: unknown; expected?: unknown };
  if (verifier.type === 'exact' && verifier.expected != null) {
    return { gold: String(verifier.expected), metric: 'accuracy' };
  }
  if (verifier.type === 'numeric_tolerance' && verifier.expected != null) {
    return { gold: String(verifier.expected), metric: 'gsm8k_exact' };
  }
  return null;
}

export function referenceAnswerFromVerifier(verifier: unknown): ReferenceAnswer | null {
  if (!Array.isArray(verifier)) return fromOne(verifier);
  // Prefer exact when a verifier list has schema + exact checks: the latter is
  // the canonical reference, while the schema only says which shapes are valid.
  for (const entry of verifier) {
    const reference = fromOne(entry);
    if (reference?.metric === 'accuracy') return reference;
  }
  for (const entry of verifier) {
    const reference = fromOne(entry);
    if (reference) return reference;
  }
  return null;
}

export function referencesForInstances(
  instances: Array<{ verifier: unknown }>,
): { references: ReferenceAnswer[]; metric: ReferenceMetric } | null {
  const references = instances.map((instance) => referenceAnswerFromVerifier(instance.verifier));
  if (references.some((reference) => reference == null)) return null;
  const typed = references as ReferenceAnswer[];
  const metric = typed[0]?.metric;
  if (!metric || typed.some((reference) => reference.metric !== metric)) return null;
  return { references: typed, metric };
}
