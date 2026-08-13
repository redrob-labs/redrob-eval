/**
 * The statistics.
 *
 * Pinned against hand-checkable values, because a confidence interval that is
 * quietly wrong is worse than none: it launders a guess into a claim. The
 * properties that matter here are that intervals stay inside [0,1] at the small
 * denominators these slices actually have, that the paired test uses only the
 * disagreements, and that a re-run gives the same answer.
 * Run: yarn test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  holmAdjust,
  mcnemar,
  pairedBootstrapDiff,
  powerWarnings,
  wilsonInterval,
} from '../../packages/harness/src/lib/stats/index.ts';
import {
  compareModels,
  outcomesByItem,
} from '../../packages/harness/src/lib/stats/compare-runs.ts';
import type { ToolRoutingReport } from '../../packages/harness/src/lib/tool-routing/types.ts';

test('a Wilson interval stays inside [0,1] where the normal approximation does not', () => {
  // 13/13 is the shape an absence slice actually has. The normal approximation
  // gives [1,1] here, claiming certainty from thirteen items.
  const perfect = wilsonInterval(13, 13);
  assert.ok(perfect.low > 0.7 && perfect.low < 0.8, `low was ${perfect.low}`);
  assert.equal(perfect.high, 1);

  const none = wilsonInterval(0, 13);
  assert.equal(none.low, 0);
  assert.ok(none.high > 0.2 && none.high < 0.3, `high was ${none.high}`);

  // A known textbook value: 50/100 gives roughly 40.4%-59.6%.
  const half = wilsonInterval(50, 100);
  assert.ok(Math.abs(half.low - 0.404) < 0.005, `low was ${half.low}`);
  assert.ok(Math.abs(half.high - 0.596) < 0.005, `high was ${half.high}`);

  // Wider at n=10 than at n=1000 for the same rate, which is the whole point.
  const small = wilsonInterval(9, 10);
  const large = wilsonInterval(900, 1000);
  assert.ok(small.high - small.low > large.high - large.low);

  assert.deepEqual(wilsonInterval(0, 0), { low: 0, high: 1 }, 'no data is total ignorance');
});

test("McNemar counts only the items the models disagreed on", () => {
  //           a: ✓ ✓ ✗ ✗        b: ✓ ✗ ✓ ✗
  const a = [true, true, false, false];
  const b = [true, false, true, false];
  const result = mcnemar(a, b);
  assert.equal(result.agreed, 2, 'both-right and both-wrong carry no information');
  assert.equal(result.aOnly, 1);
  assert.equal(result.bOnly, 1);
  // One each way is as balanced as it gets: p must be 1.
  assert.equal(result.p, 1);

  // Ten disagreements, all one way, is about as strong as this test gets.
  const strongA = Array.from({ length: 10 }, () => true);
  const strongB = Array.from({ length: 10 }, () => false);
  const strong = mcnemar(strongA, strongB);
  assert.equal(strong.aOnly, 10);
  assert.ok(strong.p < 0.005, `p was ${strong.p}`);

  // Identical models cannot be separated at all.
  const same = mcnemar([true, false, true], [true, false, true]);
  assert.equal(same.aOnly + same.bOnly, 0);
  assert.equal(same.p, 1);

  assert.throws(() => mcnemar([true], [true, false]), /same items/);
});

test("McNemar's exact p matches the binomial by hand", () => {
  // 5 vs 0 discordant: two-sided p = 2 * (1/2)^5 = 0.0625.
  const result = mcnemar(
    [true, true, true, true, true],
    [false, false, false, false, false],
  );
  assert.ok(Math.abs(result.p - 0.0625) < 1e-9, `p was ${result.p}`);
});

test('the paired bootstrap is deterministic and finds a real gap', () => {
  // a is right on 18 of 20, b on 8: a wide, obvious gap.
  const a = Array.from({ length: 20 }, (_, i) => (i < 18 ? 1 : 0));
  const b = Array.from({ length: 20 }, (_, i) => (i < 8 ? 1 : 0));
  const first = pairedBootstrapDiff(a, b, { seed: 7, iterations: 1000 });
  const again = pairedBootstrapDiff(a, b, { seed: 7, iterations: 1000 });
  // A number that moves on re-run cannot be cited.
  assert.deepEqual(first, again);
  assert.equal(first.diff, 0.5);
  assert.ok(first.significant, 'a 50-point gap over 20 items should exclude zero');
  assert.ok(first.interval.low > 0);

  // Identical scores: the difference is zero and the interval contains it.
  const flat = pairedBootstrapDiff(a, a, { seed: 7, iterations: 500 });
  assert.equal(flat.diff, 0);
  assert.ok(!flat.significant);

  assert.throws(() => pairedBootstrapDiff([1], [1, 0]), /same items/);
  const empty = pairedBootstrapDiff([], [], { seed: 1 });
  assert.equal(empty.n, 0);
  assert.ok(!empty.significant, 'no items cannot be significant');
});

test('a small paired difference is honestly reported as inconclusive', () => {
  // 19/20 against 18/20 is the kind of gap these evals produce, and it is not
  // separable at this size. The test has to say so.
  const a = Array.from({ length: 20 }, (_, i) => (i < 19 ? 1 : 0));
  const b = Array.from({ length: 20 }, (_, i) => (i < 18 ? 1 : 0));
  const boot = pairedBootstrapDiff(a, b, { seed: 3, iterations: 2000 });
  assert.ok(!boot.significant, 'a one-item gap must not read as a result');
  assert.ok(boot.interval.low <= 0 && boot.interval.high >= 0);
});

test('Holm adjustment is monotone and never lowers a p value', () => {
  const raw = [0.001, 0.02, 0.04, 0.5];
  const adjusted = holmAdjust(raw);
  assert.equal(adjusted.length, raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    assert.ok(adjusted[i]! >= raw[i]!, 'adjusting can only make a p larger');
    assert.ok(adjusted[i]! <= 1);
  }
  // Smallest raw p times the number of tests.
  assert.ok(Math.abs(adjusted[0]! - 0.004) < 1e-9, `got ${adjusted[0]}`);
  // Order is preserved: sorted raw p's give non-decreasing adjusted p's.
  const sortedAdjusted = [...adjusted];
  assert.deepEqual(sortedAdjusted, [...sortedAdjusted].sort((x, y) => x - y));
  // Position in the input is kept, not the sorted order.
  assert.deepEqual(holmAdjust([0.5, 0.001]), holmAdjust([0.001, 0.5]).reverse());
  assert.deepEqual(holmAdjust([]), []);
});

test('a comparison too small to support a claim says so', () => {
  assert.deepEqual(powerWarnings({ n: 0 }), ['no shared items, so nothing can be compared']);
  assert.match(powerWarnings({ n: 12 })[0]!, /only 12 shared item/);
  assert.match(powerWarnings({ n: 100, discordant: 3 })[0]!, /disagreed on only 3/);
  assert.match(powerWarnings({ n: 100, discordant: 0 })[0]!, /never disagreed/);
  assert.deepEqual(powerWarnings({ n: 100, discordant: 40 }), [], 'a big clean comparison is quiet');
});

/** A minimal report carrying per-item scores for one model. */
function report(model: string, outcomes: Array<[string, boolean]>): ToolRoutingReport {
  return {
    schema: 'redrob-tool-routing/v2',
    createdAt: '2026-08-13T00:00:00Z',
    modelId: model,
    hfRepoId: null,
    languageConstraints: ['en'],
    conditions: ['contract'],
    slices: [],
    deltas: [],
    examples: outcomes.map(([taskId, correct]) => ({
      taskId,
      language: 'en' as const,
      condition: 'contract' as const,
      toolset: 'core' as const,
      raw: '',
      parsed: { kind: 'parse_error' as const, raw: '', message: '' },
      score: {
        toolSelectCorrect: correct,
        argExactMatch: correct,
        absenceCorrect: null,
        parseFailed: false,
        latencyGpuMs: 1,
        latencyCpuMs: null,
      },
    })),
  };
}

test('per-item outcomes skip the items a metric does not apply to', () => {
  const r = report('m', [['t1', true], ['t2', false]]);
  // absenceCorrect is null on these, so the absence metric has nothing to say.
  assert.equal(outcomesByItem(r, 'toolSelect').size, 2);
  assert.equal(outcomesByItem(r, 'absence').size, 0, 'an inapplicable item is not a zero');
});

test('models are compared only on the items they share', () => {
  const result = compareModels({
    reports: [
      // b was never asked t3, so t3 cannot count for or against it.
      { model: 'a', report: report('a', [['t1', true], ['t2', true], ['t3', true]]) },
      { model: 'b', report: report('b', [['t1', true], ['t2', false]]) },
    ],
    metric: 'toolSelect',
    iterations: 200,
  });
  assert.equal(result.rates.find((r) => r.model === 'a')!.n, 3);
  assert.equal(result.rates.find((r) => r.model === 'b')!.n, 2);
  assert.equal(result.pairs.length, 1);
  assert.equal(result.pairs[0]!.sharedItems, 2, 'the unshared item is dropped, not scored');
  assert.equal(result.pairs[0]!.mcnemar.aOnly, 1);
  assert.equal(result.pairs[0]!.mcnemar.bOnly, 0);
  // Two items cannot support a claim, and the warning has to say it.
  assert.ok(result.pairs[0]!.warnings.length > 0);
});

test('every pair is tested and the p values are adjusted across them', () => {
  const result = compareModels({
    reports: ['a', 'b', 'c'].map((m) => ({
      model: m,
      report: report(m, [['t1', m !== 'c'], ['t2', m === 'a']]),
    })),
    metric: 'toolSelect',
    iterations: 200,
  });
  assert.equal(result.pairs.length, 3, 'three models make three pairs');
  for (const pair of result.pairs) {
    assert.ok(pair.adjustedP >= pair.mcnemar.p, 'adjusting cannot lower a p value');
  }
});
