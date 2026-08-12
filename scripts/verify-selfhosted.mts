/**
 * Offline checks for self-hosted catalog, relative cost, and mandatory caveats.
 * No GPU / network required.
 */
import assert from 'node:assert/strict';
import {
  EVAL_MODELS,
  SELF_HOSTED_CANDIDATES,
  SELF_HOSTED_ENDPOINT_ID,
  SELF_HOSTED_EXCLUSIONS,
  SERVED_MODEL_NAME,
  assertHasCaveat,
  buildSelfHostedCaveat,
  relativeCostFromThroughput,
  listSelfHostedModels,
  isIndicDataset,
  INDIC_DATASET_IDS,
  withMandatoryCaveat,
} from '@redrob/harness';
import { containsCurrency } from '../packages/harness/src/lib/reporting/no-currency.ts';

assert.equal(relativeCostFromThroughput({ modelTokPerSec: 50, largeTokPerSec: 100 }), 200);
assert.equal(relativeCostFromThroughput({ modelTokPerSec: 100, largeTokPerSec: 100 }), 100);
assert.equal(relativeCostFromThroughput({ modelTokPerSec: 200, largeTokPerSec: 100 }), 50);

const caveat = buildSelfHostedCaveat({
  hfRepoId: 'google/gemma-4-31B-it',
  license: 'apache-2.0',
  precision: 'fp8',
  maxModelLen: 8192,
  servedModelName: SERVED_MODEL_NAME,
  measuredTokPerSec: null,
  measuredAt: null,
});
assert.match(caveat, /precision=fp8/);
assert.match(caveat, /FP8/);
assert.equal(containsCurrency(caveat), false);

assert.throws(() => assertHasCaveat({}, 'empty'), /missing required caveat/);

// One endpoint, so one row. The models you can put behind it are a Deploy
// catalog, not a set of eval rows that could each answer at the same time.
const selfHosted = listSelfHostedModels();
assert.equal(selfHosted.length, 1, 'expected exactly one self-hosted endpoint row');
for (const m of selfHosted) {
  assert.equal(m.providerId, 'vllm');
  assert.equal(m.modelId, SERVED_MODEL_NAME);
  assert.ok(m.selfHosted, m.id);
  const lic = m.selfHosted!.license;
  assert.ok(lic === 'apache-2.0' || lic === 'mit', `${m.id} license ${lic}`);
  assert.ok(m.selfHosted!.hfRepoId.includes('/'), m.id);
}

const ids = new Set(EVAL_MODELS.map((m) => m.id));
assert.ok(ids.has(SELF_HOSTED_ENDPOINT_ID));
assert.ok(!ids.has('vllm-phi-4'), 'phi-4 must stay excluded from catalog');

const candidateIds = new Set<string>(Object.values(SELF_HOSTED_CANDIDATES).map((c) => c.id));
assert.ok(candidateIds.has('vllm-gemma4-e4b'));
assert.ok(candidateIds.has('vllm-gemma4-31b'));
assert.ok(candidateIds.has('vllm-qwen36-27b'));
assert.ok(!candidateIds.has('vllm-phi-4'), 'phi-4 must stay out of the deploy catalog');

assert.ok(SELF_HOSTED_EXCLUSIONS.length >= 2);
assert.ok(INDIC_DATASET_IDS.includes('in22-gen-hi-en'));
assert.equal(isIndicDataset('in22-gen-hi-en'), true);
assert.equal(isIndicDataset('gsm8k-main'), false);

const reported = withMandatoryCaveat(
  {
    targetId: SELF_HOSTED_ENDPOINT_ID,
    label: 'test',
    kind: 'model',
    metric: 'gsm8k_exact',
    n: 3,
    quality: 0.5,
    meanLatencyMs: 100,
    meanRelativeCost: 100,
    relativeCostPct: 100,
    sampleResults: [],
  },
  { sampleCount: 3, extraCaveat: 'unit-test' },
);
assertHasCaveat(reported, 'unit');
assert.match(reported.caveat, /unit-test/);

console.log('verify:selfhosted ok');
