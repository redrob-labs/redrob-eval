/**
 * Phase 1 parity gate — offline, no provider calls.
 * Run: yarn verify:phase1
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertSplitIsolation,
  buildEvalPrompt,
  getRepoRoot,
  loadDataset,
  previewDatasets,
  runMetricFixtures,
  scorePair,
  summarizeTarget,
  splitExamples,
} from '../packages/harness/src/index';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertClose(a: number, b: number, eps: number, msg: string): void {
  if (Math.abs(a - b) > eps) throw new Error(`${msg}: ${a} vs ${b}`);
}

async function main(): Promise<void> {
  console.log('=== Metric fixtures ===');
  const fixtures = runMetricFixtures();
  for (const f of fixtures) {
    const mark = f.pass ? 'PASS' : 'FAIL';
    console.log(
      `[${mark}] ${f.id} (${f.metric}) score=${f.score.toFixed(4)} expected ${f.expected ?? ''} — ${f.note}`,
    );
  }
  const failed = fixtures.filter((f) => !f.pass);
  assert(failed.length === 0, `Fixtures failed: ${failed.map((f) => f.id).join(', ')}`);
  console.log(`All ${fixtures.length} fixtures passed.\n`);

  const live = scorePair(
    'gsm8k_exact',
    '#### 18',
    'Janet makes $18 a day at the market.\n#### 18',
  );
  assert(live.score === 1, 'scorePair gsm8k smoke failed');
  assert(typeof live.feedback === 'string' && live.feedback.length > 0, 'feedback required');
  console.log('scorePair smoke + feedback: ok\n');

  console.log('=== Dataset catalog ===');
  for (const d of previewDatasets()) {
    console.log(`- ${d.id}: ${d.label} [${d.metric}] localOnly=${d.localOnly ?? false}`);
  }
  console.log('');

  console.log('=== Vendored offline load ===');
  const ids = ['gsm8k-main', 'mmlu-pooled', 'in22-gen-hi-en', 'accuracy-fixture'] as const;
  for (const id of ids) {
    const loaded = await loadDataset(id, { maxSamples: 3 });
    assert(loaded.samples.length > 0, `${id}: expected samples`);
    assert(loaded.samples[0]!.input.length > 0, `${id}: empty input`);
    assert(loaded.samples[0]!.gold.length > 0, `${id}: empty gold`);
    assert(loaded.fromCache === true, `${id}: expected vendored/offline load`);
    console.log(
      `${id}: n=${loaded.samples.length} revision=${loaded.revisionHash?.slice(0, 12) ?? loaded.revision}`,
    );
  }

  // Golden sample IDs (seed=42) — bit-for-bit against pre-Phase-1 cache subsample
  const gsm3 = await loadDataset('gsm8k-main', { maxSamples: 3 });
  const gsm3Ids = gsm3.samples.map((s) => s.id);
  assert(
    JSON.stringify(gsm3Ids) === JSON.stringify(['gsm8k-main-0', 'gsm8k-main-1', 'gsm8k-main-2']),
    `gsm8k maxSamples=3 ids mismatch: ${JSON.stringify(gsm3Ids)}`,
  );

  const gsm20 = await loadDataset('gsm8k-main', { maxSamples: 20 });
  assert(gsm20.samples.length === 20, `gsm8k expected 20 samples, got ${gsm20.samples.length}`);
  const gsm20Hash = createHash('sha256')
    .update(gsm20.samples.map((s) => s.id).join(','))
    .digest('hex')
    .slice(0, 16);
  // Fixed hash of ids gsm8k-main-0 .. gsm8k-main-19
  const expectedGsm20Hash = createHash('sha256')
    .update(
      Array.from({ length: 20 }, (_, i) => `gsm8k-main-${i}`).join(','),
    )
    .digest('hex')
    .slice(0, 16);
  assert(gsm20Hash === expectedGsm20Hash, `gsm8k-20 id hash ${gsm20Hash} != ${expectedGsm20Hash}`);

  const in22 = await loadDataset('in22-gen-hi-en', { maxSamples: 3 });
  assert(
    JSON.stringify(in22.samples.map((s) => s.id)) ===
      JSON.stringify(['in22-gen-hi-en-0', 'in22-gen-hi-en-1', 'in22-gen-hi-en-2']),
    'in22 sample ids mismatch',
  );
  console.log('Golden sample IDs: ok\n');

  console.log('=== Prompt builder snapshot ===');
  const prompt = buildEvalPrompt('math', 'What is 2+2?');
  const expectedPrompt = [
    'Solve the grade-school math word problem.',
    'Show brief reasoning if useful.',
    'End with the final numeric answer on its own line as: #### <number>',
    '',
    'What is 2+2?',
  ].join('\n');
  assert(prompt === expectedPrompt, 'buildEvalPrompt math snapshot mismatch');
  console.log('Prompt snapshot: ok\n');

  console.log('=== Aggregate snapshot ===');
  const summary = summarizeTarget({
    targetId: 'm1',
    label: 'Model 1',
    kind: 'model',
    metric: 'accuracy',
    sampleResults: [
      { sampleId: 'a', score: 1, latencyMs: 100, prediction: '1' },
      { sampleId: 'b', score: 0, latencyMs: 200, prediction: '0' },
    ],
    costWeights: [10, 10],
    largeBaselineWeight: 100,
  });
  assertClose(summary.quality, 0.5, 1e-12, 'quality');
  assertClose(summary.meanLatencyMs, 150, 1e-12, 'latency');
  assertClose(summary.relativeCostPct, 10, 1e-12, 'relativeCostPct');
  console.log('Aggregate snapshot: ok\n');

  console.log('=== Split isolation ===');
  try {
    assertSplitIsolation({ optimizedAgainst: ['train', 'test'], reported: 'test' });
    throw new Error('expected assertSplitIsolation to throw');
  } catch (e) {
    assert(
      e instanceof Error && e.message.includes('Refusing to report'),
      'wrong isolation error',
    );
  }
  assertSplitIsolation({ optimizedAgainst: ['train', 'val'], reported: 'test' });
  const split = splitExamples(
    [
      { id: '1', input: 'a', gold: 'a' },
      { id: '2', input: 'b', gold: 'b' },
      { id: '3', input: 'c', gold: 'c' },
      { id: '4', input: 'd', gold: 'd' },
      { id: '5', input: 'e', gold: 'e' },
    ],
    { train: 0.6, val: 0.2, test: 0.2 },
    42,
  );
  assert(split.train.length + split.val.length + split.test.length === 5, 'split size');
  console.log('Split isolation: ok\n');

  // Ensure NOTICE exists
  const notice = join(getRepoRoot(), 'NOTICE');
  assert(existsSync(notice), 'NOTICE file missing');
  const noticeText = readFileSync(notice, 'utf8');
  assert(noticeText.includes('agrawal2025gepa') || noticeText.includes('GEPA'), 'NOTICE must cite GEPA');

  console.log('Phase 1 verify OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
