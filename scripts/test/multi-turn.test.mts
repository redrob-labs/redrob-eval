/**
 * Turn-level scoring for multi-turn conversations.
 *
 * The loop itself is covered by `yarn verify:multi-turn`; these pin what a
 * single check means, because that is what decides whether a model is marked
 * as having forgotten something.
 * Run: yarn test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runCheck, runChecks } from '../../packages/harness/src/lib/multi-turn/checks.ts';
import { buildMultiTurnReport } from '../../packages/harness/src/lib/multi-turn/metrics.ts';
import {
  buildSystemPrompt,
  formatToolResult,
} from '../../packages/harness/src/lib/multi-turn/prompts.ts';
import { loadMultiTurnScenarios } from '../../packages/harness/src/lib/multi-turn/fixtures.ts';
import type {
  ScenarioRecord,
  TurnRecord,
} from '../../packages/harness/src/lib/multi-turn/types.ts';

test('text checks read the answer, not its formatting', () => {
  // "Tuesday, 9 AM" has not forgotten the day, and a check that says otherwise
  // is measuring capitalisation.
  assert.equal(runCheck({ kind: 'contains', text: 'thursday' }, 'Moved to Thursday.').passed, true);
  assert.equal(
    runCheck({ kind: 'contains', text: 'meeting  room' }, 'the meeting\nroom is booked').passed,
    true,
    'wrapped text is the same text',
  );
  assert.equal(runCheck({ kind: 'contains', text: 'Tokyo' }, 'Paris.').passed, false);
  assert.equal(runCheck({ kind: 'absent', text: '$' }, 'It is $40 a day.').passed, false);
  assert.equal(runCheck({ kind: 'absent', text: '$' }, 'No charge mentioned.').passed, true);
});

test('a regex is how a check asks for something exact', () => {
  assert.equal(runCheck({ kind: 'regex', pattern: '\\b6\\b|six' }, 'for 6 people').passed, true);
  assert.equal(runCheck({ kind: 'regex', pattern: '\\b6\\b|six' }, 'for 16 people').passed, false);
  assert.equal(runCheck({ kind: 'regex', pattern: '[가-힣]' }, 'Seoul').passed, false);
  assert.equal(runCheck({ kind: 'regex', pattern: '[가-힣]' }, '서울입니다').passed, true);
});

test('a tool call is scored on the tool and, when asked, the arguments', () => {
  const reply = '{"tool":"get_weather","arguments":{"city":"Seoul","day":"tomorrow"}}';
  assert.equal(runCheck({ kind: 'tool_call', tool: 'get_weather' }, reply).passed, true);
  assert.equal(
    runCheck(
      { kind: 'tool_call', tool: 'get_weather', arguments: { day: 'tomorrow', city: 'Seoul' } },
      reply,
    ).passed,
    true,
    'key order is not part of the answer',
  );
  const wrongArgs = runCheck(
    { kind: 'tool_call', tool: 'get_weather', arguments: { city: 'Busan', day: 'tomorrow' } },
    reply,
  );
  assert.equal(wrongArgs.passed, false);
  assert.match(wrongArgs.detail, /Busan/);
  assert.match(
    runCheck({ kind: 'tool_call', tool: 'send_email' }, reply).detail,
    /called get_weather, expected send_email/,
  );
});

test('declining is only correct when it is the decline that was expected', () => {
  assert.equal(runCheck({ kind: 'absence', action: 'BLOCK' }, '{"action":"BLOCK"}').passed, true);
  const wrong = runCheck({ kind: 'absence', action: 'BLOCK' }, '{"action":"DEFER"}');
  assert.equal(wrong.passed, false);
  assert.match(wrong.detail, /answered DEFER/);
  assert.equal(
    runCheck({ kind: 'absence', action: 'DEFER' }, 'I cannot do that.').passed,
    false,
    'prose is not the contract',
  );
});

test('answering from the transcript is the pass; calling again is the failure', () => {
  assert.equal(runCheck({ kind: 'no_tool_call' }, 'It will snow, about 3C.').passed, true);
  assert.equal(
    runCheck({ kind: 'no_tool_call' }, '{"tool":"get_weather","arguments":{}}').passed,
    false,
  );
  // Declining is not calling, so it satisfies this check on its own terms.
  assert.equal(runCheck({ kind: 'no_tool_call' }, '{"action":"BLOCK"}').passed, true);
});

test('a reasoning trace is not the answer', () => {
  // Models that think out loud routinely rehearse the wrong tool first.
  const reply =
    '<think>send_email? no, they asked for weather</think>{"tool":"get_weather","arguments":{}}';
  assert.equal(runCheck({ kind: 'tool_call', tool: 'get_weather' }, reply).passed, true);
  assert.equal(runCheck({ kind: 'contains', text: 'send_email' }, reply).passed, false);
});

test('every check on a turn has to hold', () => {
  const results = runChecks(
    [
      { kind: 'contains', text: 'Paris' },
      { kind: 'contains', text: 'DONE' },
    ],
    'Paris.',
  );
  assert.deepEqual(
    results.map((r) => r.passed),
    [true, false],
  );
});

test('a tool scenario carries its tools and the contract in the system prompt', () => {
  const scenario = loadMultiTurnScenarios().find((s) => s.kind === 'tool')!;
  const prompt = buildSystemPrompt(scenario)!;
  assert.match(prompt, /get_weather/);
  assert.match(prompt, /"tool":"<name>"/);
  assert.match(prompt, /BLOCK/);
  assert.match(prompt, /DEFER/);
  // A model that already has the answer must be told not to call again, or
  // "called it twice" is the harness's fault rather than the model's.
  assert.match(prompt, /answer the user in plain language/);

  const text = loadMultiTurnScenarios().find((s) => s.kind === 'text')!;
  const textPrompt = buildSystemPrompt(text);
  assert.equal(textPrompt?.includes('"tool"') ?? false, false, 'no tools, no contract');
});

test('a tool result is framed so the model can tell it from the user', () => {
  const framed = formatToolResult('get_weather', { tempC: 3 });
  assert.match(framed, /^TOOL RESULT for get_weather:/);
  assert.match(framed, /\{"tempC":3\}/);
});

test('the fixtures are conversations, in both languages, and every turn is scored', () => {
  const scenarios = loadMultiTurnScenarios();
  assert.ok(scenarios.length >= 6);
  assert.equal(new Set(scenarios.map((s) => s.id)).size, scenarios.length, 'ids are unique');
  for (const scenario of scenarios) {
    assert.ok(scenario.turns.length >= 2, `${scenario.id} is a single turn`);
    assert.ok(scenario.about.length > 0, `${scenario.id} says nothing about itself`);
    for (const turn of scenario.turns) {
      assert.ok(turn.user || turn.toolResult, `${scenario.id}: a turn with no input`);
      assert.ok(turn.expect.length > 0, `${scenario.id}: an unscored turn`);
      for (const check of turn.expect) {
        if (check.kind === 'regex') new RegExp(check.pattern, check.flags ?? 'i');
      }
    }
  }
  const withToolResult = scenarios.flatMap((s) =>
    s.turns.filter((t) => t.toolResult).map(() => s.kind),
  );
  assert.ok(withToolResult.length > 0);
  assert.ok(
    withToolResult.every((kind) => kind === 'tool'),
    'only a tool scenario can hand back a tool result',
  );
});

function turn(index: number, capability: TurnRecord['capability'], passed: boolean): TurnRecord {
  return {
    index,
    capability,
    sent: '',
    reply: '',
    checks: [],
    passed,
    latencyMs: index * 10,
  };
}

test('the report cuts the same turns by capability and by depth', () => {
  const scenarios: ScenarioRecord[] = [
    {
      scenarioId: 'a',
      language: 'en',
      kind: 'text',
      turns: [turn(1, 'instruction_retention', true), turn(2, 'context_recall', false)],
      passed: false,
      firstFailedTurn: 2,
    },
    {
      scenarioId: 'b',
      language: 'ko',
      kind: 'text',
      turns: [turn(1, 'instruction_retention', true), turn(2, 'context_recall', true)],
      passed: true,
      firstFailedTurn: null,
    },
  ];
  const report = buildMultiTurnReport({
    modelId: 'm',
    languages: ['en', 'ko'],
    scenarios,
  });
  assert.equal(report.scenarioPassRate, 0.5);
  assert.equal(report.turnPassRate, 0.75);
  assert.equal(
    report.byCapability.find((c) => c.capability === 'context_recall')?.passRate,
    0.5,
  );
  assert.equal(report.byDepth.find((d) => d.turn === 1)?.passRate, 1);
  assert.equal(report.byDepth.find((d) => d.turn === 2)?.passRate, 0.5);
  assert.equal(report.latencyMs.p50, 20);
});

test('an empty run reports zero rather than dividing by nothing', () => {
  const report = buildMultiTurnReport({ modelId: 'm', languages: [], scenarios: [] });
  assert.equal(report.scenarioPassRate, 0);
  assert.equal(report.turnPassRate, 0);
  assert.equal(report.latencyMs.p50, null);
  assert.deepEqual(report.byDepth, []);
});
