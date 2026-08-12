/**
 * How the condition table reads when a condition produced nothing.
 *
 * The failing case is real: a model that answers prose under `bare` scores no
 * accuracy at all, so every delta against it is empty and the table said
 * nothing. These tests pin what the reader is told instead.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deltaBetween,
  readConditions,
  rollUpCondition,
  rollUpToolsets,
  type ConditionSlice,
  type ToolRoutingExampleRecord,
} from '../../apps/web/src/components/compare/tool-routing.ts';

const LANGUAGES = ['en', 'hi', 'hi-Latn', 'ko'] as const;

function slice(
  condition: string,
  language: string,
  over: Partial<ConditionSlice> = {},
): ConditionSlice {
  return {
    condition,
    language,
    n: 8,
    toolSelectAccuracy: 0.75,
    argExactMatchAccuracy: 0.5,
    absenceAccuracy: 1,
    parseFailureRate: 0,
    denominators: { toolSelect: 6, argExactMatch: 6, absence: 2 },
    latencyGpuMs: { p50: 100, p95: 200 },
    latencyCpuMs: { p50: null, p95: null },
    ...over,
  };
}

/** Nothing parsed, so no metric has a denominator to divide by. */
const UNPARSEABLE: Partial<ConditionSlice> = {
  toolSelectAccuracy: null,
  argExactMatchAccuracy: null,
  absenceAccuracy: null,
  parseFailureRate: 1,
  denominators: { toolSelect: 0, argExactMatch: 0, absence: 0 },
};

function run(opts: {
  bare?: Partial<ConditionSlice>;
  contract?: Partial<ConditionSlice>;
}) {
  const slices: ConditionSlice[] = [];
  for (const language of LANGUAGES) {
    slices.push(slice('bare', language, opts.bare ?? {}));
    slices.push(slice('contract', language, opts.contract ?? {}));
  }
  return slices;
}

test('a condition that parsed nothing is named, not left as a dash', () => {
  const slices = run({ bare: UNPARSEABLE });
  const read = readConditions(slices);

  assert.equal(read.bareUnparseable, true, 'the reader has to be told why the row is empty');

  const bare = rollUpCondition(slices, 'bare');
  const contract = rollUpCondition(slices, 'contract');
  const toolSelect = deltaBetween(contract, bare, 'toolSelectAccuracy');
  assert.equal(toolSelect.value, null);
  assert.equal(toolSelect.missing, 'older', 'bare is the side with nothing to score');

  // Parse failure is the one column that still says something in this case.
  const parse = deltaBetween(contract, bare, 'parseFailureRate');
  assert.equal(parse.missing, null);
  assert.equal(parse.value, -1);
});

test('an accuracy the contract never moved is not sold as an improvement', () => {
  const read = readConditions(run({}));
  assert.equal(read.contractChangedAccuracy, false);
  assert.equal(read.contractParseGain, 0);
});

test('an accuracy the contract did move is reported as more than tidier output', () => {
  const read = readConditions(run({ contract: { toolSelectAccuracy: 0.875 } }));
  assert.equal(read.contractChangedAccuracy, true);
});

test('a bare condition that mostly works reports the size of the gain instead', () => {
  const read = readConditions(run({ bare: { parseFailureRate: 0.25 } }));
  assert.equal(read.bareUnparseable, false);
  assert.equal(read.contractParseGain, -0.25, 'the contract removed a quarter of the failures');
});

function example(
  over: Partial<ToolRoutingExampleRecord> & { toolset: string },
): ToolRoutingExampleRecord {
  return {
    taskId: 'x',
    language: 'en',
    condition: 'contract',
    raw: '{}',
    score: {
      toolSelectCorrect: true,
      argExactMatch: true,
      absenceCorrect: null,
      parseFailed: false,
      latencyGpuMs: 10,
    },
    ...over,
  };
}

test('a toolset row only counts the examples that scored that metric', () => {
  const rows = rollUpToolsets(
    [
      example({ toolset: 'core' }),
      example({
        toolset: 'core',
        score: {
          toolSelectCorrect: null,
          argExactMatch: null,
          absenceCorrect: true,
          parseFailed: false,
          latencyGpuMs: 10,
        },
      }),
      example({
        toolset: 'wide',
        score: {
          toolSelectCorrect: false,
          argExactMatch: false,
          absenceCorrect: null,
          parseFailed: false,
          latencyGpuMs: 10,
        },
      }),
      // A different condition never belongs in the split.
      example({ toolset: 'wide', condition: 'bare' }),
    ],
    'contract',
  );

  const core = rows.find((r) => r.toolset === 'core')!;
  const wide = rows.find((r) => r.toolset === 'wide')!;
  assert.equal(core.n, 2);
  assert.equal(core.toolSelectAccuracy, 1, 'the refusal task has no tool to pick');
  assert.equal(core.absenceAccuracy, 1);
  assert.equal(wide.n, 1, 'the bare reply is not in the contract split');
  assert.equal(wide.toolSelectAccuracy, 0);
});
