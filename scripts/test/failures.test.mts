/**
 * Failure classification.
 *
 * The shapes here are the ones real sub-10B models actually produced against the
 * tool-routing set, because the point of a taxonomy is that it separates the
 * failures a prompt or parser fix would clear from the ones that need a better
 * model. Getting that split wrong is the failure mode worth testing.
 * Run: yarn test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyToolRoutingExample,
  failuresFromMultiTurn,
  failuresFromToolRouting,
  filterFailures,
  promptRequest,
  tallyFailures,
  RECOVERABLE_KINDS,
} from '../../packages/harness/src/lib/failures/index.ts';
import { parseToolRoutingPrediction } from '../../packages/harness/src/lib/tool-routing/parse.ts';
import { scoreToolRoutingExample } from '../../packages/harness/src/lib/tool-routing/metrics.ts';
import type {
  ExpectedOutcome,
  ToolRoutingExampleRecord,
  ToolRoutingReport,
} from '../../packages/harness/src/lib/tool-routing/types.ts';
import type { MultiTurnReport } from '../../packages/harness/src/lib/multi-turn/types.ts';

/** Build an example the way the harness does: parse the reply, then score it. */
function example(reply: string, expected: ExpectedOutcome, over: Partial<ToolRoutingExampleRecord> = {}): ToolRoutingExampleRecord {
  const parsed = parseToolRoutingPrediction(reply);
  return {
    taskId: 'en-task',
    language: 'en',
    condition: 'contract',
    toolset: 'core',
    raw: parsed.raw,
    parsed,
    score: scoreToolRoutingExample({ expected, prediction: parsed, latencyGpuMs: 5 }),
    ...over,
  };
}

const weather: ExpectedOutcome = {
  kind: 'call',
  tool: 'get_weather',
  arguments: { city: 'Seoul', day: 'tomorrow' },
};

test('a correct answer is not a failure', () => {
  const ok = example(
    '{"tool":"get_weather","arguments":{"city":"Seoul","day":"tomorrow"}}',
    weather,
  );
  assert.equal(classifyToolRoutingExample(ok), null);
});

test('the tool name in "action" is an envelope failure, not a bare format one', () => {
  // LFM2.5 and Llama-3.2-3B both do this. Calling it `format` would hide the
  // most useful finding in the set: the model routed correctly.
  const record = example(
    '{"action":"get_weather","arguments":{"city":"Seoul","day":"tomorrow"}}',
    weather,
  );
  const verdict = classifyToolRoutingExample(record)!;
  assert.equal(verdict.kind, 'envelope');
  assert.match(verdict.detail, /right tool through the wrong key/);
  assert.ok(RECOVERABLE_KINDS.includes(verdict.kind), 'an envelope failure is recoverable');
});

test('a wrapper failure that also names the wrong tool says so', () => {
  const record = example(
    '{"action":"send_email","arguments":{"city":"Seoul","day":"tomorrow"}}',
    weather,
  );
  const verdict = classifyToolRoutingExample(record)!;
  assert.equal(verdict.kind, 'envelope');
  assert.match(verdict.detail, /wrong tool inside it/);
});

test('prose instead of the contract is a format failure', () => {
  const record = example('Sure! It will be sunny in Seoul tomorrow.', weather);
  const verdict = classifyToolRoutingExample(record)!;
  assert.equal(verdict.kind, 'format');
  assert.ok(RECOVERABLE_KINDS.includes(verdict.kind));
});

test('choosing the wrong tool is told apart from getting its arguments wrong', () => {
  const wrongTool = classifyToolRoutingExample(
    example('{"tool":"get_air_quality","arguments":{"city":"Seoul","day":"tomorrow"}}', weather),
  )!;
  assert.equal(wrongTool.kind, 'wrong_tool');
  assert.match(wrongTool.detail, /chose get_air_quality/);

  const badArgs = classifyToolRoutingExample(
    example('{"tool":"get_weather","arguments":{"city":"Busan","day":"tomorrow"}}', weather),
  )!;
  assert.equal(badArgs.kind, 'bad_arguments');
  assert.match(badArgs.detail, /Busan/);
  // Neither is a wrapper problem, so neither is in the cheap-to-fix bucket.
  assert.ok(!RECOVERABLE_KINDS.includes(wrongTool.kind));
  assert.ok(!RECOVERABLE_KINDS.includes(badArgs.kind));
});

test('acting when it should have declined is separated from declining wrongly', () => {
  const shouldDefer: ExpectedOutcome = { kind: 'absence', action: 'DEFER' };
  const acted = classifyToolRoutingExample(
    example('{"tool":"send_payment","arguments":{"recipient":"x","amount":0,"currency":"KRW"}}', shouldDefer),
  )!;
  assert.equal(acted.kind, 'missed_abstention');
  assert.match(acted.detail, /called send_payment/);

  const wrongWay = classifyToolRoutingExample(example('{"action":"BLOCK"}', shouldDefer))!;
  assert.equal(wrongWay.kind, 'wrong_abstention');
  assert.match(wrongWay.detail, /declined with BLOCK/);
});

test('a provider error is not counted against the model', () => {
  const record = example('', weather, { error: 'HTTP 503' });
  const verdict = classifyToolRoutingExample(record)!;
  assert.equal(verdict.kind, 'call_error');
  assert.equal(verdict.detail, 'HTTP 503');
});

test('the recorded expectation is shown, not a guess at which axis failed', () => {
  const report: ToolRoutingReport = {
    schema: 'redrob-tool-routing/v2',
    createdAt: '2026-08-13T00:00:00Z',
    modelId: 'm',
    hfRepoId: null,
    languageConstraints: ['en'],
    conditions: ['contract'],
    slices: [],
    deltas: [],
    examples: [
      example('{"tool":"get_weather","arguments":{"city":"Busan","day":"tomorrow"}}', weather, {
        expected: weather,
      }),
    ],
  };
  const f = failuresFromToolRouting(report)[0]!;
  // "wrong arguments" is not a finding until the wanted ones are visible.
  assert.equal(f.expected, 'get_weather {"city":"Seoul","day":"tomorrow"}');
  assert.equal(f.expectedTool, 'get_weather');
  assert.equal(f.actualTool, 'get_weather');

  const declined: ToolRoutingReport = {
    ...report,
    examples: [
      example('{"tool":"translate_text","arguments":{}}', { kind: 'absence', action: 'BLOCK' }, {
        expected: { kind: 'absence', action: 'BLOCK' },
      }),
    ],
  };
  assert.equal(failuresFromToolRouting(declined)[0]!.expected, '{"action":"BLOCK"}');
});

test('a report without a recorded expectation still says which axis failed', () => {
  // Reports written before the expectation was kept must not invent a fixture.
  const record = example(
    '{"tool":"get_weather","arguments":{"city":"Busan","day":"tomorrow"}}',
    weather,
  );
  assert.equal(record.expected, undefined);
  const report: ToolRoutingReport = {
    schema: 'redrob-tool-routing/v2',
    createdAt: '2026-08-13T00:00:00Z',
    modelId: 'm',
    hfRepoId: null,
    languageConstraints: ['en'],
    conditions: ['contract'],
    slices: [],
    deltas: [],
    examples: [record],
  };
  assert.match(failuresFromToolRouting(report)[0]!.expected!, /different arguments/);
});

test('the request is shown without the tool catalogue', () => {
  // A contract prompt is the same page of schemas on every task; printing it
  // buries the one line that differs.
  const prompt =
    'You are a tool router. Available tools:\n- get_weather: …\n\n' +
    'Respond with exactly one JSON object.\n\nUser:\nWhat is the weather in Seoul tomorrow?';
  assert.equal(promptRequest(prompt), 'What is the weather in Seoul tomorrow?');
  // No marker: keep what there is rather than dropping it.
  assert.equal(promptRequest('just a question'), 'just a question');
  assert.ok(promptRequest(`\nUser:\n${'x'.repeat(900)}`).length < 600, 'long requests are clipped');
});

test('a report becomes failure records carrying the evidence', () => {
  const report: ToolRoutingReport = {
    schema: 'redrob-tool-routing/v2',
    createdAt: '2026-08-13T00:00:00Z',
    modelId: 'granite-4.1-8b',
    hfRepoId: null,
    languageConstraints: ['en'],
    conditions: ['contract'],
    slices: [],
    deltas: [],
    examples: [
      example('{"tool":"get_weather","arguments":{"city":"Seoul","day":"tomorrow"}}', weather),
      example('nope', weather, { taskId: 'en-bad', prompt: 'What is the weather?' }),
    ],
  };
  const failures = failuresFromToolRouting(report);
  assert.equal(failures.length, 1, 'only the failing example is collected');
  const f = failures[0]!;
  assert.equal(f.kind, 'format');
  assert.equal(f.model, 'granite-4.1-8b');
  assert.equal(f.item, 'en-bad');
  assert.equal(f.language, 'en');
  assert.equal(f.prompt, 'What is the weather?');
  assert.equal(f.actual, 'nope', 'the raw reply is kept for reading');
  assert.equal(f.id, 'granite-4.1-8b|en-bad');
});

test('multi-turn failures are classified by the capability the turn declared', () => {
  const report: MultiTurnReport = {
    schema: 'redrob-multi-turn/v1',
    createdAt: '2026-08-13T00:00:00Z',
    modelId: 'gpt-4o-mini',
    languages: ['en'],
    scenariosPassed: 0,
    scenarioPassRate: 0,
    turnsPassed: 0,
    turnPassRate: 0,
    byCapability: [],
    byDepth: [],
    callErrors: 0,
    latencyMs: { p50: null, p95: null },
    scenarios: [
      {
        scenarioId: 'mt-en-suffix',
        language: 'en',
        kind: 'text',
        passed: false,
        firstFailedTurn: 3,
        turns: [
          {
            index: 1,
            capability: 'instruction_retention',
            sent: 'end every reply with DONE',
            reply: 'OK DONE',
            checks: [],
            passed: true,
            latencyMs: 10,
          },
          {
            index: 3,
            capability: 'instruction_retention',
            sent: 'And of Japan?',
            reply: 'Tokyo.',
            checks: [{ check: { kind: 'contains', text: 'DONE' }, passed: false, detail: 'missing "DONE"' }],
            passed: false,
            latencyMs: 10,
          },
          {
            index: 4,
            capability: 'tool_use_result',
            sent: 'TOOL RESULT …',
            reply: '{"tool":"get_weather","arguments":{}}',
            checks: [],
            passed: false,
            latencyMs: 10,
            desynced: true,
          },
        ],
      },
    ],
  };
  const failures = failuresFromMultiTurn(report);
  assert.equal(failures.length, 2, 'the passing turn is not collected');
  assert.equal(failures[0]!.kind, 'instruction_dropped');
  assert.match(failures[0]!.detail, /missing "DONE"/);
  assert.equal(failures[0]!.turn, 3);
  // A desync is the protocol coming apart, not the model choosing wrongly.
  assert.equal(failures[1]!.kind, 'desynced');
  assert.equal(failures[1]!.turn, 4);
});

test('failures filter by kind, model, language, tool and text', () => {
  const failures = [
    { id: '1', kind: 'format' as const, detail: 'x', source: 'tool-routing', model: 'a', item: 't1', language: 'en' },
    { id: '2', kind: 'wrong_tool' as const, detail: 'chose send_email', source: 'tool-routing', model: 'b', item: 't2', language: 'ko', actualTool: 'send_email' },
    { id: '3', kind: 'format' as const, detail: 'y', source: 'multi-turn', model: 'b', item: 's1', turn: 2 },
  ];
  assert.equal(filterFailures(failures, { kind: 'format' }).length, 2);
  assert.equal(filterFailures(failures, { kind: ['format', 'wrong_tool'] }).length, 3);
  assert.equal(filterFailures(failures, { model: 'b' }).length, 2);
  assert.equal(filterFailures(failures, { language: 'ko' }).length, 1);
  assert.equal(filterFailures(failures, { tool: 'send_email' }).length, 1);
  assert.equal(filterFailures(failures, { turn: 2 }).length, 1);
  assert.equal(filterFailures(failures, { search: 'SEND_EMAIL' }).length, 1);
  assert.equal(filterFailures(failures).length, 3, 'no filter keeps everything');
});

test('the tally is commonest first and shares sum to one', () => {
  const failures = [
    { id: '1', kind: 'format' as const, detail: '', source: 's', model: 'a', item: '1' },
    { id: '2', kind: 'format' as const, detail: '', source: 's', model: 'a', item: '2' },
    { id: '3', kind: 'wrong_tool' as const, detail: '', source: 's', model: 'a', item: '3' },
  ];
  const tally = tallyFailures(failures);
  assert.deepEqual(tally.map((t) => t.kind), ['format', 'wrong_tool']);
  assert.equal(tally[0]!.count, 2);
  assert.ok(Math.abs(tally.reduce((n, t) => n + t.share, 0) - 1) < 1e-9);
  assert.deepEqual(tallyFailures([]), [], 'no failures is not a divide by zero');
});
