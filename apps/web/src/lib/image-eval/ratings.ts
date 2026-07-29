import type { ImagePreferenceRating, ImageSuite } from './types';

export function emptyPreferenceRatings(
  suite: ImageSuite,
  modelIds: string[],
): ImagePreferenceRating[] {
  return (suite.prompts ?? []).map((prompt) => ({
    suite: suite.suite,
    prompt_id: prompt.id,
    models: [...modelIds],
    winner: '',
    notes: '',
    source: undefined,
  }));
}

export function ensureRunRatings(params: {
  ratings: ImagePreferenceRating[];
  suite: ImageSuite;
  modelIds: string[];
}): ImagePreferenceRating[] {
  if (params.ratings?.length > 0) return params.ratings;
  if (!params.suite || params.modelIds.length === 0) return params.ratings ?? [];
  return emptyPreferenceRatings(params.suite, params.modelIds);
}

/** Win counts (ties ignored). */
export function tallyWins(
  ratings: ImagePreferenceRating[],
  modelIds: string[],
): Record<string, { wins: number; rated: number }> {
  const out: Record<string, { wins: number; rated: number }> = {};
  for (const id of modelIds) out[id] = { wins: 0, rated: 0 };
  for (const row of ratings) {
    if (!row.winner || row.winner === 'tie') continue;
    for (const id of row.models) {
      if (out[id]) out[id].rated += 1;
    }
    if (out[row.winner]) out[row.winner].wins += 1;
  }
  return out;
}
