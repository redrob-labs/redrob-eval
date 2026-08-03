import type { WeightPresetId } from './types';

/**
 * Rank swing = max(rank) − min(rank) across presets (1-based ranks).
 */
export function rankSwing(
  modelIds: string[],
  rankUnderPreset: Record<WeightPresetId, Map<string, number>>,
): Map<string, number> {
  const out = new Map<string, number>();
  const presets = Object.keys(rankUnderPreset) as WeightPresetId[];
  for (const id of modelIds) {
    let min = Infinity;
    let max = -Infinity;
    for (const p of presets) {
      const r = rankUnderPreset[p]?.get(id);
      if (r == null) continue;
      min = Math.min(min, r);
      max = Math.max(max, r);
    }
    out.set(id, Number.isFinite(min) && Number.isFinite(max) ? max - min : 0);
  }
  return out;
}
