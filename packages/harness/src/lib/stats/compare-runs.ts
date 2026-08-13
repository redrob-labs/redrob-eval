import type { ToolRoutingExampleRecord, ToolRoutingReport } from '../tool-routing/types';

import {
  holmAdjust,
  mcnemar,
  pairedBootstrapDiff,
  powerWarnings,
  wilsonInterval,
  type Interval,
  type McNemarResult,
} from './index';

export {
  holmAdjust,
  mcnemar,
  pairedBootstrapDiff,
  powerWarnings,
  wilsonInterval,
} from './index';

/**
 * Turning stored reports into a claim about two models.
 *
 * The unit is the item, not the run: two models are compared only on the items
 * they both answered. Anything one of them was never asked is dropped rather than
 * counted as a loss, because a missing cell is a gap in the sweep and not
 * evidence about the model.
 */

/** Which axis of the tool-routing score to compare on. */
export type ToolRoutingMetric =
  | 'toolSelect'
  | 'argExact'
  | 'absence'
  /** Parsed at all, as the contract asked. Inverted so higher is better. */
  | 'parsed';

/** A per-item 0/1 outcome, or null when the metric does not apply to that item. */
function outcome(example: ToolRoutingExampleRecord, metric: ToolRoutingMetric): boolean | null {
  const s = example.score;
  switch (metric) {
    case 'toolSelect':
      return s.toolSelectCorrect;
    case 'argExact':
      return s.argExactMatch;
    case 'absence':
      return s.absenceCorrect;
    case 'parsed':
      return !s.parseFailed;
  }
}

/** Per-item outcomes for one model, keyed by task id. */
export function outcomesByItem(
  report: ToolRoutingReport,
  metric: ToolRoutingMetric,
): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const example of report.examples ?? []) {
    const value = outcome(example, metric);
    // null means the metric does not apply here - an absence task has no tool to
    // select - and an inapplicable item is not a zero.
    if (value != null) out.set(example.taskId, value);
  }
  return out;
}

export interface ModelRate {
  model: string;
  successes: number;
  n: number;
  rate: number;
  interval: Interval;
}

export interface PairComparison {
  a: ModelRate;
  b: ModelRate;
  /** Items both models were scored on for this metric. */
  sharedItems: number;
  mcnemar: McNemarResult;
  diff: { value: number; interval: Interval };
  /** Holm-adjusted across every pair in the same call. Equals `mcnemar.p` alone. */
  adjustedP: number;
  warnings: string[];
}

export interface CompareModelsResult {
  metric: ToolRoutingMetric;
  rates: ModelRate[];
  pairs: PairComparison[];
}

/**
 * Compare every pair of models on one metric, over the items they share.
 *
 * p values are Holm-adjusted across the pairs produced here: comparing six
 * models is fifteen tests, and at that point one result under 0.05 is expected
 * from noise alone.
 */
export function compareModels(params: {
  reports: Array<{ model: string; report: ToolRoutingReport }>;
  metric: ToolRoutingMetric;
  seed?: number;
  iterations?: number;
}): CompareModelsResult {
  const byModel = params.reports.map(({ model, report }) => ({
    model,
    outcomes: outcomesByItem(report, params.metric),
  }));

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

  const pairs: Omit<PairComparison, 'adjustedP'>[] = [];
  for (let i = 0; i < byModel.length; i += 1) {
    for (let j = i + 1; j < byModel.length; j += 1) {
      const left = byModel[i]!;
      const right = byModel[j]!;
      // Only items both were scored on. A cell one model never ran is a hole in
      // the sweep, and scoring it as a loss would invent evidence.
      const shared = [...left.outcomes.keys()].filter((k) => right.outcomes.has(k)).sort();
      const aVals = shared.map((k) => left.outcomes.get(k)!);
      const bVals = shared.map((k) => right.outcomes.get(k)!);
      const test = mcnemar(aVals, bVals);
      const boot = pairedBootstrapDiff(
        aVals.map((v) => (v ? 1 : 0)),
        bVals.map((v) => (v ? 1 : 0)),
        { seed: params.seed ?? 12345, iterations: params.iterations ?? 2000 },
      );
      pairs.push({
        a: rates[i]!,
        b: rates[j]!,
        sharedItems: shared.length,
        mcnemar: test,
        diff: { value: boot.diff, interval: boot.interval },
        warnings: powerWarnings({
          n: shared.length,
          discordant: test.aOnly + test.bOnly,
        }),
      });
    }
  }

  const adjusted = holmAdjust(pairs.map((p) => p.mcnemar.p));
  return {
    metric: params.metric,
    rates,
    pairs: pairs.map((p, i) => ({ ...p, adjustedP: adjusted[i]! })),
  };
}
