import { compositeScore, presentAxesFromScores, renormalizeWeights } from './composite';
import { pearsonR } from './correlation';
import { DEFAULT_GOOD_ENOUGH_SECONDS, WEIGHT_PRESETS } from './defaults';
import { wallClockSeconds } from './latency';
import {
  normalizeCostLog,
  normalizePreferenceElo,
  normalizeQuality,
  normalizeSpeed,
} from './normalize';
import { nonDominatedSet } from './pareto';
import { relativeCostPct } from './relative-cost';
import { rankSwing } from './sensitivity';
import { assertTokenProfile } from './token-profile';
import type {
  AxisId,
  AxisScore,
  CompareRequest,
  CompareResult,
  ModelAxisScores,
  ModelEntry,
  RankedModel,
  WeightPresetId,
  Weights,
} from './types';

function emptyAxis(feedback: string): AxisScore {
  return { score: null, feedback };
}

function rankByComposite(
  rows: Array<{ modelId: string; composite: number | null }>,
): Map<string, number> {
  const sortable = rows
    .map((r, i) => ({ ...r, i }))
    .sort((a, b) => {
      if (a.composite == null && b.composite == null) return a.i - b.i;
      if (a.composite == null) return 1;
      if (b.composite == null) return -1;
      if (b.composite !== a.composite) return b.composite - a.composite;
      return a.i - b.i;
    });
  const map = new Map<string, number>();
  sortable.forEach((r, idx) => map.set(r.modelId, idx + 1));
  return map;
}

function scoreAxesForModels(params: {
  models: ModelEntry[];
  baseline: ModelEntry;
  profile: CompareRequest['tokenProfile'];
  qualityById: Map<string, number | null>;
  goodEnoughSeconds: number;
}): {
  byId: Map<string, ModelAxisScores>;
  rawQuality: Array<number | null>;
  rawPreference: Array<number | null>;
} {
  const { models, baseline, profile, qualityById, goodEnoughSeconds } = params;

  const relativeCosts: Array<number | null> = [];
  const costUpper: boolean[] = [];
  const costFeedback: string[] = [];
  const wallClocks: Array<number | null> = [];
  const rawQuality: Array<number | null> = [];
  const rawPreference: Array<number | null> = [];

  for (const m of models) {
    rawQuality.push(qualityById.get(m.id) ?? null);
    rawPreference.push(m.published?.arenaElo ?? null);

    try {
      const c = relativeCostPct({ model: m, baseline, profile });
      relativeCosts.push(c.relativeCostPct);
      costUpper.push(c.upperBound);
      costFeedback.push(c.feedback);
    } catch (e) {
      relativeCosts.push(null);
      costUpper.push(false);
      costFeedback.push(e instanceof Error ? e.message : 'Cost failed.');
    }

    const tps = m.published?.tokensPerSecond;
    const ttft = m.published?.timeToFirstToken;
    if (tps != null && tps > 0 && ttft != null && ttft >= 0) {
      try {
        wallClocks.push(
          wallClockSeconds({
            outputTokens: profile.outputTokens,
            parallelSections: profile.parallelSections,
            tokensPerSecond: tps,
            timeToFirstToken: ttft,
          }),
        );
      } catch {
        wallClocks.push(null);
      }
    } else {
      wallClocks.push(null);
    }
  }

  const qNorm = normalizeQuality(rawQuality);
  const pNorm = normalizePreferenceElo(rawPreference);
  const cNorm = normalizeCostLog(relativeCosts).map((s, i) => ({
    ...s,
    upperBound: costUpper[i] || undefined,
    feedback: costUpper[i]
      ? `${costFeedback[i]} ${s.feedback}`
      : s.score == null
        ? costFeedback[i]!
        : `${costFeedback[i]} ${s.feedback}`,
  }));
  const sNorm = normalizeSpeed(wallClocks, goodEnoughSeconds);

  const byId = new Map<string, ModelAxisScores>();
  models.forEach((m, i) => {
    const axes = {
      quality: qNorm[i]!,
      preference: pNorm[i]!,
      cost: cNorm[i]!,
      speed: sNorm[i]!,
    };
    const record: Record<AxisId, AxisScore> = axes;
    byId.set(m.id, {
      modelId: m.id,
      ...axes,
      relativeCostPct: relativeCosts[i] ?? null,
      wallClockSeconds: wallClocks[i] ?? null,
      presentAxes: presentAxesFromScores(record),
    });
  });

  return { byId, rawQuality, rawPreference };
}

function compositeFor(
  axes: ModelAxisScores,
  weights: Weights,
): { composite: AxisScore; weightsUsed: Weights } {
  const record: Record<AxisId, AxisScore> = {
    quality: axes.quality,
    preference: axes.preference,
    cost: axes.cost,
    speed: axes.speed,
  };
  const present = presentAxesFromScores(record);
  const weightsUsed = renormalizeWeights(weights, present);
  return { composite: compositeScore(record, weights), weightsUsed };
}

/**
 * Rank candidate models on quality / preference / cost / speed.
 * Pure: registry + optional run qualities supplied by caller.
 */
export function compareModels(params: {
  request: CompareRequest;
  registry: ModelEntry[];
  /** When qualitySource=run — per-model quality in [0,1] or other positive scale. */
  runQualities?: Record<string, number>;
}): CompareResult {
  const profile = assertTokenProfile(params.request.tokenProfile);
  const goodEnoughSeconds = params.request.goodEnoughSeconds ?? DEFAULT_GOOD_ENOUGH_SECONDS;
  const weights = params.request.weights;
  const notes: string[] = [];

  const byReg = new Map(params.registry.map((m) => [m.id, m]));
  const models: ModelEntry[] = [];
  for (const id of params.request.modelIds) {
    const m = byReg.get(id);
    if (!m) {
      notes.push(`Unknown model id skipped: ${id}`);
      continue;
    }
    models.push(m);
  }
  if (models.length === 0) {
    throw new Error('No valid models to compare.');
  }

  const baseline = byReg.get(params.request.baselineModelId);
  if (!baseline) {
    throw new Error(`Baseline model not in registry: ${params.request.baselineModelId}`);
  }
  if (!models.some((m) => m.id === baseline.id)) {
    models.push(baseline);
    notes.push('Baseline model added to comparison set.');
  }

  const qualityById = new Map<string, number | null>();
  let qualityAxisLabel: string;
  if (params.request.qualitySource === 'run') {
    qualityAxisLabel = params.request.runId
      ? `Run quality (${params.request.runId}${params.request.split ? `, ${params.request.split}` : ''})`
      : 'Run quality';
    for (const m of models) {
      const q = params.runQualities?.[m.id];
      qualityById.set(m.id, q != null && Number.isFinite(q) ? q : null);
    }
  } else {
    qualityAxisLabel = 'Registry benchmark composite (illustrative)';
    for (const m of models) {
      qualityById.set(m.id, m.published?.benchmarkComposite ?? null);
    }
  }

  const { byId, rawQuality, rawPreference } = scoreAxesForModels({
    models,
    baseline,
    profile,
    qualityById,
    goodEnoughSeconds,
  });

  // Sensitivity across presets
  const presetRanks = {} as Record<WeightPresetId, Map<string, number>>;
  for (const [presetId, presetWeights] of Object.entries(WEIGHT_PRESETS) as Array<
    [WeightPresetId, Weights]
  >) {
    const rows = models.map((m) => {
      const axes = byId.get(m.id)!;
      const { composite } = compositeFor(axes, presetWeights);
      return { modelId: m.id, composite: composite.score };
    });
    presetRanks[presetId] = rankByComposite(rows);
  }
  const swings = rankSwing(
    models.map((m) => m.id),
    presetRanks,
  );

  // Primary ranking under request weights
  const primaryRows = models.map((m) => {
    const axes = byId.get(m.id)!;
    const { composite, weightsUsed } = compositeFor(axes, weights);
    return { modelId: m.id, label: m.label, axes, composite, weightsUsed };
  });
  const primaryRanks = rankByComposite(
    primaryRows.map((r) => ({ modelId: r.modelId, composite: r.composite.score })),
  );

  const frontierIds = new Set(
    nonDominatedSet(
      models.map((m) => {
        const axes = byId.get(m.id)!;
        return {
          id: m.id,
          quality: rawQuality[models.indexOf(m)] ?? null,
          preference: rawPreference[models.indexOf(m)] ?? null,
          cost: axes.relativeCostPct,
          speed: null,
          wallClockSeconds: axes.wallClockSeconds,
        };
      }),
    ),
  );

  const ranked: RankedModel[] = primaryRows
    .map((r) => {
      const missingAxes = (['quality', 'preference', 'cost', 'speed'] as AxisId[]).filter(
        (a) => !r.axes.presentAxes.includes(a),
      );
      return {
        modelId: r.modelId,
        label: r.label,
        rank: primaryRanks.get(r.modelId)!,
        composite: r.composite,
        axes: r.axes,
        weightsUsed: r.weightsUsed,
        onParetoFrontier: frontierIds.has(r.modelId),
        rankSwing: swings.get(r.modelId) ?? 0,
        missingAxes,
      };
    })
    .sort((a, b) => a.rank - b.rank);

  // Correlation on raw quality vs preference where both present
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < models.length; i++) {
    const q = rawQuality[i];
    const p = rawPreference[i];
    if (q != null && p != null) {
      xs.push(q);
      ys.push(p);
    }
  }
  const correlation = pearsonR(xs, ys);

  // Baseline must be exactly 100% relative cost
  const baselineAxes = byId.get(baseline.id);
  if (baselineAxes?.relativeCostPct != null) {
    const drift = Math.abs(baselineAxes.relativeCostPct - 100);
    if (drift > 1e-6) {
      notes.push(
        `Baseline relative cost was ${baselineAxes.relativeCostPct}; expected 100 (numerical drift ${drift}).`,
      );
    }
  }

  return {
    baselineModelId: baseline.id,
    tokenProfile: profile,
    weights,
    goodEnoughSeconds,
    qualitySource: params.request.qualitySource,
    qualityAxisLabel,
    ranked,
    correlation,
    frontierModelIds: [...frontierIds],
    notes,
  };
}

/** Re-rank an existing CompareResult under new weights without recomputing cost/latency. */
export function rerankWithWeights(result: CompareResult, weights: Weights): CompareResult {
  const rows = result.ranked.map((r) => {
    const { composite, weightsUsed } = compositeFor(r.axes, weights);
    return { ...r, composite, weightsUsed };
  });
  const ranks = rankByComposite(rows.map((r) => ({ modelId: r.modelId, composite: r.composite.score })));
  const ranked = rows
    .map((r) => ({ ...r, rank: ranks.get(r.modelId)! }))
    .sort((a, b) => a.rank - b.rank);
  return { ...result, weights, ranked };
}

export { emptyAxis };
