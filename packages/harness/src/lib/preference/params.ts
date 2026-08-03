import { createHash } from 'node:crypto';
import type { PreferenceGenerationParams } from './types';

export const DEFAULT_PREFERENCE_GENERATION_PARAMS: PreferenceGenerationParams = {
  temperature: 0,
  /** No explicit cap — providers omit/raise to model-allowed max. */
  maxTokens: null,
  parallelSections: 1,
};

export function assertIdenticalGenerationParams(
  params: Partial<PreferenceGenerationParams> | PreferenceGenerationParams,
): PreferenceGenerationParams {
  const temperature =
    params.temperature != null
      ? Number(params.temperature)
      : DEFAULT_PREFERENCE_GENERATION_PARAMS.temperature;

  let maxTokens: number | null;
  if (params.maxTokens === null) {
    maxTokens = null;
  } else if (params.maxTokens === undefined) {
    maxTokens = DEFAULT_PREFERENCE_GENERATION_PARAMS.maxTokens;
  } else {
    maxTokens = Number(params.maxTokens);
    if (!Number.isFinite(maxTokens) || maxTokens < 1) {
      throw new Error(
        'generationParams.maxTokens must be null (unlimited) or a finite number ≥ 1',
      );
    }
  }

  const parallelSections = Math.max(
    1,
    Math.floor(
      params.parallelSections != null
        ? Number(params.parallelSections)
        : DEFAULT_PREFERENCE_GENERATION_PARAMS.parallelSections,
    ),
  );
  if (!Number.isFinite(temperature) || temperature < 0) {
    throw new Error('generationParams.temperature must be a finite number ≥ 0');
  }
  const out: PreferenceGenerationParams = {
    temperature,
    maxTokens,
    parallelSections,
  };
  if (params.seed != null) {
    if (!Number.isFinite(params.seed)) throw new Error('generationParams.seed must be finite');
    out.seed = Math.floor(Number(params.seed));
  }
  return out;
}

/** Stable fingerprint so a run can prove every model saw the same template. */
export function promptFingerprint(system: string, userTemplate: string): string {
  return createHash('sha256')
    .update(system, 'utf8')
    .update('\n---\n', 'utf8')
    .update(userTemplate, 'utf8')
    .digest('hex')
    .slice(0, 16);
}

export function taskIdFromSpecParts(parts: {
  goal: string;
  rubric: string;
  exampleIds: string[];
}): string {
  const h = createHash('sha256')
    .update(parts.goal.trim(), 'utf8')
    .update('\n', 'utf8')
    .update(parts.rubric.trim(), 'utf8')
    .update('\n', 'utf8')
    .update(parts.exampleIds.join('|'), 'utf8')
    .digest('hex')
    .slice(0, 12);
  return `cg-${h}`;
}
