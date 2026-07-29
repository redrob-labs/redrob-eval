/**
 * Offline GEPA unit checks — no provider calls.
 * Run: yarn verify:gepa
 */
import {
  InstanceFrontier,
  assertSplitIsolation,
  betterFeasible,
  isFeasible,
  makeReflectiveDataset,
  sampleMinibatch,
  systemAwareMerge,
  seedCandidate,
  type EvalBatch,
  type Example,
} from '../packages/harness/src/index';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function batch(
  outcomes: Array<{ exampleId: string; score: number }>,
  quality: number,
  tokens: number,
): EvalBatch {
  return {
    quality,
    meanRelativeCost: 50,
    promptTokens: Math.floor(tokens / 2),
    completionTokens: Math.ceil(tokens / 2),
    totalTokens: tokens,
    latencyP50: 100,
    outcomes: outcomes.map((o) => ({
      ...o,
      feedback: o.score < 1 ? 'failed case' : 'ok',
    })),
    traces: outcomes.map((o) => `example=${o.exampleId}\nscore=${o.score}`),
  };
}

function main(): void {
  console.log('=== Fitness floor ===');
  const low = batch([{ exampleId: 'a', score: 0 }], 0.2, 10);
  const highCheap = batch([{ exampleId: 'a', score: 1 }], 0.9, 20);
  const highExpensive = batch([{ exampleId: 'a', score: 1 }], 0.9, 80);
  assert(!isFeasible(low, 0.5), 'low should be infeasible');
  assert(isFeasible(highCheap, 0.5), 'high should be feasible');
  assert(betterFeasible(highCheap, highExpensive, 0.5), 'fewer tokens wins among feasible');
  assert(betterFeasible(highCheap, low, 0.5), 'feasible beats infeasible');
  console.log('ok\n');

  console.log('=== Instance frontier coverage ===');
  const frontier = new InstanceFrontier();
  const c1 = seedCandidate({
    instruction: 'A',
    model: { modelId: 'm1', providerId: 'openrouter' },
  });
  const c2 = seedCandidate({
    instruction: 'B',
    model: { modelId: 'm2', providerId: 'openrouter' },
  });
  frontier.update(
    c1.id,
    batch(
      [
        { exampleId: 'e0', score: 1 },
        { exampleId: 'e1', score: 0 },
      ],
      0.5,
      10,
    ),
  );
  frontier.update(
    c2.id,
    batch(
      [
        { exampleId: 'e0', score: 0 },
        { exampleId: 'e1', score: 1 },
      ],
      0.5,
      10,
    ),
  );
  const cov = frontier.getCoverage();
  assert((cov[c1.id] ?? 0) >= 1, 'c1 should cover ≥1');
  assert((cov[c2.id] ?? 0) >= 1, 'c2 should cover ≥1');
  const picked = frontier.selectCandidate([c1, c2], () => 0.01);
  assert(picked.id === c1.id || picked.id === c2.id, 'select from pool');
  console.log('ok\n');

  console.log('=== makeReflectiveDataset ===');
  const examples: Example[] = [
    { id: 'e0', input: 'hi', gold: 'hello', split: 'train' },
  ];
  const refl = makeReflectiveDataset({
    examples,
    batch: batch([{ exampleId: 'e0', score: 0 }], 0, 5),
  });
  assert(refl.length === 1 && refl[0]!.feedback.length > 0, 'ASI feedback required');
  console.log('ok\n');

  console.log('=== systemAwareMerge ===');
  const merged = systemAwareMerge(
    { ...c1, demos: [{ input: 'x', output: '1' }], lessons: ['l1'] },
    { ...c2, demos: [{ input: 'y', output: '2' }, { input: 'z', output: '3' }], lessons: ['l2', 'l3'] },
  );
  assert(merged.parentIds.includes(c1.id) && merged.parentIds.includes(c2.id), 'parents');
  assert(merged.demos.length >= 1, 'merged demos');
  assert(merged.id !== c1.id, 'new id');
  console.log('ok\n');

  console.log('=== minibatch sample ===');
  const mb = sampleMinibatch(
    [
      { id: '1', input: 'a', gold: 'a' },
      { id: '2', input: 'b', gold: 'b' },
      { id: '3', input: 'c', gold: 'c' },
    ],
    2,
    () => 0.5,
  );
  assert(mb.length === 2, 'minibatch size');
  console.log('ok\n');

  console.log('=== split isolation ===');
  try {
    assertSplitIsolation({ optimizedAgainst: ['train', 'test'], reported: 'test' });
    throw new Error('expected throw');
  } catch (e) {
    assert(e instanceof Error && e.message.includes('Refusing'), 'refuse test leak');
  }
  assertSplitIsolation({ optimizedAgainst: ['train', 'val'], reported: 'test' });
  console.log('ok\n');

  console.log('GEPA verify OK');
}

main();
