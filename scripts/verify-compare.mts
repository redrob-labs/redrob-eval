/**
 * Offline multi-axis compare checks — no network.
 * Run: yarn verify:compare
 */
import {
  assertNoCurrency,
  assertNoCurrencyInValue,
  breakEvenForRank,
  compareModels,
  compareResultToMarkdown,
  containsCurrency,
  ILLUSTRATIVE_TOKEN_PROFILE,
  loadCompareRegistry,
  relativeCostPct,
  renormalizeWeights,
  toPublicRegistryEntry,
  wallClockSeconds,
  WEIGHT_PRESETS,
  type ModelEntry,
  type TokenProfile,
  type Weights,
} from '../packages/harness/src/index';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function almostEqual(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

function fixtureModel(partial: Partial<ModelEntry> & Pick<ModelEntry, 'id' | 'rates'>): ModelEntry {
  return {
    label: partial.label ?? partial.id,
    provider: partial.provider ?? 'fixture',
    contextWindow: partial.contextWindow ?? 8192,
    sources: partial.sources ?? [{ field: 'rates', url: 'https://example.invalid', retrieved: '2026-08-01' }],
    published: partial.published,
    openWeights: partial.openWeights,
    ...partial,
  };
}

function main(): void {
  console.log('=== Relative cost: with vs without cache rate ===');
  const profileCached: TokenProfile = {
    ...ILLUSTRATIVE_TOKEN_PROFILE,
    uncachedInputTokens: 1000,
    cachedInputTokens: 9000,
    outputTokens: 500,
    failureRate: 0,
    label: 'fixture cache-heavy',
  };
  const baseline = fixtureModel({
    id: 'base',
    rates: { input: 1, output: 2, cachedInput: 0.1 },
  });
  const withCache = fixtureModel({
    id: 'with-cache',
    rates: { input: 1, output: 2, cachedInput: 0.1 },
  });
  const withoutCache = fixtureModel({
    id: 'no-cache',
    rates: { input: 1, output: 2 }, // cachedInput undefined → upper bound
  });
  const a = relativeCostPct({ model: withCache, baseline, profile: profileCached });
  const b = relativeCostPct({ model: withoutCache, baseline, profile: profileCached });
  assert(almostEqual(a.relativeCostPct, 100), `with-cache should be 100%, got ${a.relativeCostPct}`);
  assert(!a.upperBound, 'with-cache should not be upper bound');
  assert(b.upperBound, 'no-cache should be upper bound');
  assert(b.relativeCostPct > a.relativeCostPct, 'missing cache rate must look worse (upper bound)');
  console.log('ok\n');

  console.log('=== Fan-out latency inversion N=1 vs N=13 ===');
  // High TTFT / high throughput (reasoning-like) vs low TTFT / low throughput
  const highTtft = { tokensPerSecond: 200, timeToFirstToken: 3.0 };
  const lowTtft = { tokensPerSecond: 50, timeToFirstToken: 0.15 };
  const outTokens = 1300;
  const w1High = wallClockSeconds({
    outputTokens: outTokens,
    parallelSections: 1,
    ...highTtft,
  });
  const w1Low = wallClockSeconds({
    outputTokens: outTokens,
    parallelSections: 1,
    ...lowTtft,
  });
  assert(w1High < w1Low, `At N=1 high-throughput should win (${w1High} vs ${w1Low})`);
  const w13High = wallClockSeconds({
    outputTokens: outTokens,
    parallelSections: 13,
    ...highTtft,
  });
  const w13Low = wallClockSeconds({
    outputTokens: outTokens,
    parallelSections: 13,
    ...lowTtft,
  });
  assert(w13High > w13Low, `At N=13 high-TTFT should lose (${w13High} vs ${w13Low})`);
  console.log('ok\n');

  console.log('=== Weight renormalization when axis missing ===');
  const full: Weights = { quality: 0.4, preference: 0.2, cost: 0.2, speed: 0.2 };
  const renorm = renormalizeWeights(full, ['quality', 'cost', 'speed']);
  assert(almostEqual(renorm.preference, 0), 'missing preference weight must be 0');
  const sum = renorm.quality + renorm.cost + renorm.speed;
  assert(almostEqual(sum, 1), `renormalized weights must sum to 1 (got ${sum})`);
  assert(almostEqual(renorm.quality, 0.4 / 0.8), 'quality share after drop');
  console.log('ok\n');

  console.log('=== Break-even bisection converges and is monotonic ===');
  // Toy: rank improves as quality increases: rank = 4 - floor(q*3) clamped
  const evaluate = (q: number) => {
    if (q >= 0.9) return 1;
    if (q >= 0.7) return 2;
    if (q >= 0.5) return 3;
    return 4;
  };
  const be = breakEvenForRank({
    targetRank: 2,
    evaluate,
    lo: 0,
    hi: 1,
    higherIsBetter: true,
    tol: 1e-5,
  });
  assert(be.value != null, be.feedback);
  assert(be.value! >= 0.7 - 1e-3, `break-even should be near 0.7, got ${be.value}`);
  assert(evaluate(be.value!) <= 2, 'break-even value must achieve target rank');
  assert(evaluate(be.value! - 0.05) > 2 || be.value! < 0.05, 'slightly below should be worse or at floor');
  // Monotonic: higher quality never worsens rank in this toy
  let prev = 99;
  for (let q = 0; q <= 1; q += 0.05) {
    const r = evaluate(q);
    assert(r <= prev, 'toy rank must be monotonic non-increasing in quality');
    prev = r;
  }
  console.log('ok\n');

  console.log('=== Baseline always 100% + registry compare ===');
  const registry = loadCompareRegistry();
  assert(registry.length >= 8, 'registry should have ≥8 illustrative models');
  const baselineId = 'or/openai/gpt-4o';
  const result = compareModels({
    request: {
      modelIds: registry.map((m) => m.id),
      tokenProfile: ILLUSTRATIVE_TOKEN_PROFILE,
      weights: WEIGHT_PRESETS.balanced,
      baselineModelId: baselineId,
      qualitySource: 'registry',
    },
    registry,
  });
  const baseRow = result.ranked.find((r) => r.modelId === baselineId);
  assert(baseRow != null, 'baseline row present');
  assert(
    baseRow!.axes.relativeCostPct != null && almostEqual(baseRow!.axes.relativeCostPct, 100),
    `baseline relative cost must be 100%, got ${baseRow!.axes.relativeCostPct}`,
  );
  console.log('ok\n');

  console.log('=== No currency in rendered output / export / public registry ===');
  const md = compareResultToMarkdown(result);
  assertNoCurrency(md, 'markdown export');
  assert(!containsCurrency(md), 'markdown must not contain currency');
  assertNoCurrencyInValue(result, 'CompareResult');
  for (const e of registry) {
    const pub = toPublicRegistryEntry(e);
    assertNoCurrencyInValue(pub, `public ${e.id}`);
    assert(!('rates' in pub), 'public entry must omit rates');
    const serialized = JSON.stringify(pub);
    assertNoCurrency(serialized, `public JSON ${e.id}`);
  }
  // Intentionally ensure a dollar string would fail the guard
  let threw = false;
  try {
    assertNoCurrency('costs $0.02 per call', 'probe');
  } catch {
    threw = true;
  }
  assert(threw, 'assertNoCurrency must fail on dollar amounts');
  console.log('ok\n');

  console.log('=== Missing-axis row marked ===');
  const mistral = result.ranked.find((r) => r.modelId.includes('mistral'));
  assert(mistral != null, 'mistral row');
  assert(mistral!.missingAxes.includes('preference') || mistral!.missingAxes.includes('speed'),
    `mistral should miss preference and/or speed, got ${mistral!.missingAxes.join(',')}`);
  console.log('ok\n');

  console.log('All compare checks passed.');
}

main();
