import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTextEvalReport } from '../../packages/harness/src/lib/eval/artifact.ts';
import { failuresFromTextEval } from '../../packages/harness/src/lib/failures/collect.ts';
import { compareTextEvalModels } from '../../packages/harness/src/lib/stats/compare-text.ts';
import type {
  EvalRunMeta,
  EvalSampleResult,
  EvalTargetSummary,
} from '../../packages/harness/src/lib/eval/types.ts';

const prompts = [
  { id: 'p1', input: '2 + 2?', gold: '4' },
  { id: 'p2', input: '3 + 4?', gold: '7' },
  { id: 'p3', input: '5 + 6?', gold: '11' },
];

const meta: EvalRunMeta = {
  runId: 'run-x',
  datasetId: 'generated-linear-equation',
  datasetLabel: 'Linear equation (en)',
  task: 'custom',
  metric: 'gsm8k_exact',
  sampleCount: 3,
  seed: 7,
  largeBaselineId: null,
  finishedAt: '2026-08-13T00:00:00.000Z',
  scored: true,
  prompts,
};

function target(
  id: string,
  results: EvalSampleResult[],
): EvalTargetSummary {
  return {
    targetId: id,
    label: id,
    kind: 'model',
    metric: 'gsm8k_exact',
    n: results.length,
    quality: results.reduce((sum, result) => sum + result.score, 0) / results.length,
    meanLatencyMs: 10,
    meanRelativeCost: 1,
    relativeCostPct: 100,
    sampleResults: results,
  };
}

const sample = (
  sampleId: string,
  score: number,
  prediction: string,
  error?: string,
): EvalSampleResult => ({
  sampleId,
  score,
  prediction,
  latencyMs: 10,
  ...(error ? { error } : {}),
});

test('text eval artifact keeps prompts, references and per-model evidence', () => {
  const report = buildTextEvalReport({
    meta,
    targets: [target('a', [sample('p1', 1, '4')])],
  });
  assert.equal(report.schema, 'redrob-text-eval/v1');
  assert.equal(report.meta.prompts?.[0]?.gold, '4');
  assert.equal(report.targets[0]?.sampleResults[0]?.prediction, '4');
});

test('deterministic text failures show expected, actual and prompt', () => {
  const report = buildTextEvalReport({
    meta,
    targets: [
      target('a', [
        sample('p1', 1, '4'),
        sample('p2', 0, '8'),
        sample('p3', 0, '', 'HTTP 503'),
      ]),
    ],
  });
  const failures = failuresFromTextEval(report);
  assert.equal(failures.length, 2);
  assert.deepEqual(
    failures.map((failure) => failure.kind),
    ['wrong_answer', 'call_error'],
  );
  assert.equal(failures[0]?.expected, '7');
  assert.equal(failures[0]?.actual, '8');
  assert.equal(failures[0]?.prompt, '3 + 4?');
  assert.equal(failures[0]?.id, 'a|p2');
  assert.equal(failures[1]?.detail, 'HTTP 503');
});

test('continuous text score is a partial answer rather than binary wrong', () => {
  const report = buildTextEvalReport({
    meta: { ...meta, metric: 'chrf' },
    targets: [
      {
        ...target('a', [sample('p1', 0.6, 'quatre')]),
        metric: 'chrf',
      },
    ],
  });
  const failure = failuresFromTextEval(report)[0]!;
  assert.equal(failure.kind, 'partial_answer');
  assert.match(failure.detail, /60%/);
});

test('paired text comparison uses only shared successful samples', () => {
  const reportA = buildTextEvalReport({
    meta,
    targets: [
      target('a', [
        sample('p1', 1, '4'),
        sample('p2', 1, '7'),
        sample('p3', 1, '11'),
      ]),
    ],
  });
  const reportB = buildTextEvalReport({
    meta,
    targets: [
      target('b', [
        sample('p1', 1, '4'),
        sample('p2', 0, '8'),
        sample('p3', 0, '', 'provider failed'),
      ]),
    ],
  });
  const result = compareTextEvalModels({
    reports: [
      { model: 'a', report: reportA },
      { model: 'b', report: reportB },
    ],
    iterations: 200,
  });
  assert.equal(result.metric, 'pass');
  assert.equal(result.rates.find((rate) => rate.model === 'a')?.n, 3);
  assert.equal(result.rates.find((rate) => rate.model === 'b')?.n, 2);
  assert.equal(result.pairs[0]?.sharedItems, 2);
  assert.equal(result.pairs[0]?.mcnemar.aOnly, 1);
  assert.ok(result.pairs[0]!.warnings.some((warning) => warning.includes('only 2')));
});
