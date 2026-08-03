import { matrixFromGenerations } from './matrix';
import { isLengthTruncation, sectionLengthStats, truncationRate } from './usage';
import type {
  Generation,
  ModelRunStats,
  PreferenceRun,
  PreferenceRunSummary,
  SectionGeneration,
} from './types';

export function summarizePreferenceRun(params: {
  run: PreferenceRun;
  generations: Generation[];
  relativeCostWeightByModel?: Record<string, number>;
}): PreferenceRunSummary {
  const { run, generations } = params;
  const completion = matrixFromGenerations(run.modelIds, run.inputIds, generations);
  const byModel: ModelRunStats[] = [];

  for (const modelId of run.modelIds) {
    const gens = generations.filter((g) => g.modelId === modelId);
    const okGens = gens.filter((g) => !g.error);
    const errors = gens.filter((g) => g.error).length;
    const trunc = truncationRate(gens);
    const meanOutputTokens =
      okGens.length > 0
        ? okGens.reduce((s, g) => s + g.usage.outputTokens, 0) / okGens.length
        : 0;
    const reasoningVals = okGens
      .map((g) => g.usage.reasoningTokens)
      .filter((x): x is number => x != null);
    const meanReasoningTokens =
      reasoningVals.length > 0
        ? reasoningVals.reduce((a, b) => a + b, 0) / reasoningVals.length
        : 0;

    const allSections: SectionGeneration[] = [];
    for (const g of okGens) {
      if (g.sections?.length) allSections.push(...g.sections);
    }

    const stats: ModelRunStats = {
      modelId,
      ok: okGens.length,
      errors,
      truncationRate: trunc,
      meanOutputTokens,
      meanReasoningTokens,
    };
    if (run.generationParams.parallelSections > 1 && allSections.length > 0) {
      stats.sectionLengthDistribution = sectionLengthStats(
        allSections,
        run.generationParams.maxTokens,
      );
    }
    byModel.push(stats);
  }

  const anyTrunc = byModel.some((m) => m.truncationRate > 0);
  const nearCap = byModel.some(
    (m) => (m.sectionLengthDistribution?.fractionNearMaxTokens ?? 0) > 0.5,
  );

  let truncationWarningMessage: string | undefined;
  if (anyTrunc || nearCap) {
    const parts: string[] = [];
    if (anyTrunc) {
      parts.push(
        'Non-zero truncationRate: some outputs stopped on a length/token cap. Preference votes on truncated text measure the cap, not the model.',
      );
    }
    if (nearCap) {
      parts.push(
        'Per-section lengths cluster near maxTokens across models — classic cap signature. Raise maxTokens or shorten sections before voting.',
      );
    }
    truncationWarningMessage = parts.join(' ');
  }

  let relativeCostPctByModel: Record<string, number> | undefined;
  const weights = params.relativeCostWeightByModel;
  if (weights) {
    const baselineId = run.baselineModelId ?? run.modelIds[0];
    const baselineW = baselineId != null ? weights[baselineId] : undefined;
    if (baselineW != null && baselineW > 0) {
      relativeCostPctByModel = {};
      for (const id of run.modelIds) {
        const w = weights[id];
        if (w != null) relativeCostPctByModel[id] = (w / baselineW) * 100;
      }
    }
  }

  return {
    runId: run.id,
    completion,
    byModel,
    truncationWarning: Boolean(truncationWarningMessage),
    truncationWarningMessage,
    relativeCostPctByModel,
  };
}

/** Cell-level finishReason: length if any section truncated, else first non-empty / primary. */
export function aggregateFinishReason(sections: SectionGeneration[]): string {
  if (sections.some((s) => isLengthTruncation(s.finishReason))) {
    const hit = sections.find((s) => isLengthTruncation(s.finishReason));
    return hit?.finishReason || 'length';
  }
  return sections.find((s) => s.finishReason)?.finishReason ?? sections[0]?.finishReason ?? '';
}
