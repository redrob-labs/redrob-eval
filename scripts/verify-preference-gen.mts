/**
 * Offline preference-generation checks — no provider calls.
 * Run: yarn verify:preference-gen
 */
import {
  assertIdenticalGenerationParams,
  buildCustomGoalSpec,
  isLengthTruncation,
  preferencePromptFingerprint,
  runPreferenceGeneration,
  splitUsageFromProvider,
  summarizePreferenceRun,
  truncationRate,
  type PreferenceCaller,
  type PreferenceRun,
} from '../packages/harness/src/index';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function almostEqual(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

function makeTask() {
  return buildCustomGoalSpec({
    goal: 'Answer clearly.',
    rubric: 'Correctness and completeness.',
    examplesRaw: [
      JSON.stringify({
        id: 'a',
        input: 'Q1',
        sections: ['part-a', 'part-b'],
      }),
      JSON.stringify({ id: 'b', input: 'Q2' }),
      JSON.stringify({ id: 'c', input: 'Q3' }),
    ].join('\n'),
  });
}

async function main(): Promise<void> {
  console.log('=== Identical generation params enforced ===');
  const params = assertIdenticalGenerationParams({
    temperature: 0.2,
    maxTokens: 256,
    parallelSections: 1,
    seed: 7,
  });
  assert(params.temperature === 0.2, 'temperature');
  assert(params.maxTokens === 256, 'maxTokens');
  assert(params.parallelSections === 1, 'parallelSections');
  assert(params.seed === 7, 'seed');
  let threw = false;
  try {
    assertIdenticalGenerationParams({ temperature: -1, maxTokens: 10 });
  } catch {
    threw = true;
  }
  assert(threw, 'negative temperature must throw');
  console.log('ok\n');

  console.log('=== Reasoning tokens kept separate from output tokens ===');
  const usage = splitUsageFromProvider({
    inputTokens: 100,
    cachedInputTokens: 20,
    outputTokens: 80,
    reasoningTokens: 30,
  });
  assert(usage.uncachedInputTokens === 80, `uncached ${usage.uncachedInputTokens}`);
  assert(usage.cachedInputTokens === 20, 'cached');
  assert(usage.outputTokens === 50, `visible output should peel reasoning (got ${usage.outputTokens})`);
  assert(usage.reasoningTokens === 30, 'reasoning kept');
  console.log('ok\n');

  console.log('=== Truncation rate + fail-soft + completion matrix ===');
  const task = makeTask();
  const fingerprint = preferencePromptFingerprint(task);
  const run: PreferenceRun = {
    id: '2099-01-01_000000_fixture',
    taskId: 'cg-fixture',
    task,
    modelIds: ['m1', 'm2'],
    inputIds: ['a', 'b', 'c'],
    generationParams: params,
    promptFingerprint: fingerprint,
    createdAt: '2099-01-01T00:00:00.000Z',
    status: 'running',
  };

  const caller: PreferenceCaller = async ({ modelId, user }) => {
    if (modelId === 'm1' && user.includes('Q2')) {
      throw new Error('simulated provider error');
    }
    if (modelId === 'm2' && user.includes('Q3')) {
      return {
        text: 'cut off mid-wor',
        usage: splitUsageFromProvider({ inputTokens: 10, outputTokens: 256 }),
        finishReason: 'length',
        latency: { timeToFirstTokenMs: 5, totalMs: 40 },
      };
    }
    return {
      text: `ok:${modelId}`,
      usage: splitUsageFromProvider({
        inputTokens: 10,
        outputTokens: 20,
        reasoningTokens: modelId === 'm1' ? 5 : undefined,
      }),
      finishReason: 'stop',
      latency: { timeToFirstTokenMs: 3, totalMs: 25 },
    };
  };

  const { generations, summary, matrix } = await runPreferenceGeneration({
    run,
    examplesById: new Map(task.examples.map((e) => [e.id, e])),
    caller,
  });

  assert(generations.length === 6, `expected 6 cells, got ${generations.length}`);
  const errCell = generations.find((g) => g.modelId === 'm1' && g.inputId === 'b');
  assert(Boolean(errCell?.error), 'm1/b should error');
  const truncCell = generations.find((g) => g.modelId === 'm2' && g.inputId === 'c');
  assert(isLengthTruncation(truncCell?.finishReason ?? ''), 'm2/c truncated');
  assert(matrix.completed === 6, `matrix completed ${matrix.completed}`);
  assert(matrix.cells.m1?.b === 'error', 'matrix error cell');
  assert(matrix.cells.m2?.c === 'truncated', 'matrix truncated cell');
  assert(matrix.cells.m1?.a === 'ok', 'matrix ok cell');

  const m2 = summary.byModel.find((m) => m.modelId === 'm2');
  assert(m2 != null, 'm2 stats');
  assert(almostEqual(m2!.truncationRate, 1 / 3), `m2 trunc ${m2!.truncationRate}`);
  assert(summary.truncationWarning, 'truncation warning must fire');
  assert(Boolean(summary.truncationWarningMessage), 'warning message');

  const m1Ok = generations.filter((g) => g.modelId === 'm1' && !g.error);
  for (const g of m1Ok) {
    if (g.usage.reasoningTokens != null) {
      assert(g.usage.outputTokens === 15, `visible 20-5=15 got ${g.usage.outputTokens}`);
      assert(g.usage.reasoningTokens === 5, 'reasoning separate');
    }
  }

  assert(run.promptFingerprint === fingerprint, 'fingerprint frozen on run');
  console.log('ok\n');

  console.log('=== parallelSections section length distribution ===');
  const fanRun: PreferenceRun = {
    ...run,
    id: '2099-01-01_000001_fan',
    modelIds: ['m1'],
    inputIds: ['a'],
    generationParams: assertIdenticalGenerationParams({
      temperature: 0,
      maxTokens: 50,
      parallelSections: 2,
    }),
  };
  const fanCaller: PreferenceCaller = async () => ({
    text: 'x'.repeat(40),
    usage: splitUsageFromProvider({ inputTokens: 5, outputTokens: 48 }),
    finishReason: 'length',
    latency: { timeToFirstTokenMs: 1, totalMs: 10 },
  });
  const fan = await runPreferenceGeneration({
    run: fanRun,
    examplesById: new Map(task.examples.map((e) => [e.id, e])),
    caller: fanCaller,
  });
  const dist = fan.summary.byModel[0]?.sectionLengthDistribution;
  assert(dist != null, 'section distribution present');
  assert(dist!.n === 2, `n sections ${dist!.n}`);
  assert(dist!.fractionNearMaxTokens === 1, 'near-cap fraction');
  assert(fan.generations[0]?.sections?.length === 2, 'sections on generation');
  console.log('ok\n');

  console.log('=== summarize truncationRate helper ===');
  assert(almostEqual(truncationRate(fan.generations), 1), 'all truncated');
  const emptySum = summarizePreferenceRun({ run: fanRun, generations: [] });
  assert(emptySum.completion.completed === 0, 'empty summary');
  console.log('ok\n');

  console.log('All preference-gen checks passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
