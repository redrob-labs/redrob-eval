import type { TextEvalReport } from '../eval/artifact';
import {
  holmAdjust,
  mcnemar,
  pairedBootstrapDiff,
  powerWarnings,
  wilsonInterval,
} from './index';
import type { CompareModelsResult, ModelRate, PairComparison } from './compare-runs';

/**
 * Paired comparison for deterministic reference-answer text benchmarks.
 *
 * A sample passes only at score 1. This is exact for the workflow this layer is
 * introduced for (`accuracy` and `gsm8k_exact`), and keeps partial chrF credit
 * out of a binary claim it cannot support.
 */
export function compareTextEvalModels(params: {
  reports: Array<{ model: string; report: TextEvalReport }>;
  seed?: number;
  iterations?: number;
}): Omit<CompareModelsResult, 'metric'> & { metric: 'pass' } {
  const byModel = params.reports.map(({ model, report }) => {
    const target = report.targets.find((candidate) => candidate.targetId === model);
    const outcomes = new Map<string, boolean>();
    for (const sample of target?.sampleResults ?? []) {
      if (!sample.error) outcomes.set(sample.sampleId, sample.score >= 1);
    }
    return { model, outcomes };
  });

  const rates: ModelRate[] = byModel.map(({ model, outcomes }) => {
    const values = [...outcomes.values()];
    const successes = values.filter(Boolean).length;
    return {
      model,
      successes,
      n: values.length,
      rate: values.length ? successes / values.length : 0,
      interval: wilsonInterval(successes, values.length),
    };
  });

  const pairs: Array<Omit<PairComparison, 'adjustedP'>> = [];
  for (let i = 0; i < byModel.length; i += 1) {
    for (let j = i + 1; j < byModel.length; j += 1) {
      const a = byModel[i]!;
      const b = byModel[j]!;
      const shared = [...a.outcomes.keys()].filter((id) => b.outcomes.has(id)).sort();
      const av = shared.map((id) => a.outcomes.get(id)!);
      const bv = shared.map((id) => b.outcomes.get(id)!);
      const test = mcnemar(av, bv);
      const diff = pairedBootstrapDiff(
        av.map(Number),
        bv.map(Number),
        { seed: params.seed ?? 12345, iterations: params.iterations ?? 2000 },
      );
      pairs.push({
        a: rates[i]!,
        b: rates[j]!,
        sharedItems: shared.length,
        mcnemar: test,
        diff: { value: diff.diff, interval: diff.interval },
        warnings: powerWarnings({
          n: shared.length,
          discordant: test.aOnly + test.bOnly,
        }),
      });
    }
  }
  const adjusted = holmAdjust(pairs.map((pair) => pair.mcnemar.p));
  return {
    metric: 'pass',
    rates,
    pairs: pairs.map((pair, index) => ({ ...pair, adjustedP: adjusted[index]! })),
  };
}
