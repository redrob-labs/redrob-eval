/**
 * Offline checks for the multi-turn harness.
 *
 * No network and no keys: the model side is scripted, which is the only way to
 * assert what the harness does with a perfect model, a forgetful one, and one
 * that never makes the call the script is waiting on.
 */
import assert from 'node:assert/strict';
import {
  loadMultiTurnScenarios,
  multiTurnScenariosFor,
  runMultiTurnHarness,
  runScenario,
  type LoadedScenario,
  type MultiTurnCaller,
} from '@redrob/harness';

const scenarios = loadMultiTurnScenarios();

// Fixtures: both languages, both kinds, every turn declaring what it is for.
assert.ok(scenarios.length >= 6, 'the fixture set is too thin to say anything');
const languages = new Set(scenarios.map((s) => s.language));
assert.ok(languages.has('en') && languages.has('ko'), 'both languages are represented');
assert.ok(scenarios.some((s) => s.kind === 'tool'));
assert.ok(scenarios.some((s) => s.kind === 'text'));
for (const scenario of scenarios) {
  assert.ok(scenario.turns.length >= 2, `${scenario.id} is not a conversation`);
  assert.ok(scenario.turns[0]!.user, `${scenario.id} must open with the user`);
  for (const turn of scenario.turns) {
    assert.ok(turn.capability, `${scenario.id}: every turn says what it is for`);
    assert.ok(turn.expect.length > 0, `${scenario.id}: every turn is scored`);
  }
  if (scenario.kind === 'tool') {
    assert.ok(scenario.tools.length > 0, `${scenario.id}: tool scenario needs tools`);
  }
}
assert.equal(multiTurnScenariosFor(['ko']).every((s) => s.language === 'ko'), true);

/** A caller that replies with whatever the script says, turn by turn. */
function scripted(replies: string[]): MultiTurnCaller {
  let turn = 0;
  return async () => ({ text: replies[turn++] ?? '', latencyMs: 5 });
}

const toolScenario: LoadedScenario = {
  id: 'fake-tool',
  language: 'en',
  kind: 'tool',
  about: 'call, read the result, do not call again',
  toolNames: ['get_weather'],
  tools: loadMultiTurnScenarios().find((s) => s.kind === 'tool')!.tools.slice(0, 1),
  turns: [
    {
      user: 'Weather in Seoul tomorrow?',
      capability: 'tool_call',
      expect: [
        {
          kind: 'tool_call',
          tool: 'get_weather',
          arguments: { city: 'Seoul', day: 'tomorrow' },
        },
      ],
    },
    {
      toolResult: { tool: 'get_weather', result: { tempC: 3, condition: 'snow' } },
      capability: 'tool_use_result',
      expect: [
        { kind: 'no_tool_call' },
        { kind: 'contains', text: 'snow' },
      ],
    },
  ],
};

// The happy path: the call is made, the result comes back, the answer uses it.
{
  const record = await runScenario(
    toolScenario,
    scripted([
      '{"tool":"get_weather","arguments":{"city":"Seoul","day":"tomorrow"}}',
      'It will snow in Seoul tomorrow, around 3C.',
    ]),
  );
  assert.equal(record.passed, true, 'a model that does everything right passes');
  assert.equal(record.firstFailedTurn, null);
  assert.match(record.turns[1]!.sent, /TOOL RESULT for get_weather/);
  assert.match(record.turns[1]!.sent, /"condition":"snow"/);
  assert.equal(record.turns[1]!.desynced, undefined);
}

// The tool result is not offered for a call that never happened.
{
  const record = await runScenario(
    toolScenario,
    scripted(['Sure, let me check the weather for you.', 'It will snow.']),
  );
  assert.equal(record.turns[0]!.passed, false, 'prose is not a tool call');
  assert.equal(record.turns[1]!.desynced, true, 'the script and the model came apart');
  assert.equal(record.turns[1]!.passed, false, 'a desynced turn cannot be a pass');
  // The rest of the conversation still ran, so the transcript is readable.
  assert.equal(record.turns.length, 2);
  assert.equal(record.firstFailedTurn, 1);
}

// Calling the same tool again, with the answer already in the transcript.
{
  const record = await runScenario(
    toolScenario,
    scripted([
      '{"tool":"get_weather","arguments":{"city":"Seoul","day":"tomorrow"}}',
      '{"tool":"get_weather","arguments":{"city":"Seoul","day":"tomorrow"}}',
    ]),
  );
  assert.equal(record.turns[0]!.passed, true);
  assert.equal(record.turns[1]!.passed, false, 'the answer was already there');
  assert.match(
    record.turns[1]!.checks.find((c) => c.check.kind === 'no_tool_call')!.detail,
    /called get_weather again/,
  );
}

// Wrong arguments fail even when the tool is right.
{
  const record = await runScenario(
    toolScenario,
    scripted([
      '{"tool":"get_weather","arguments":{"city":"Busan","day":"tomorrow"}}',
      'It will snow.',
    ]),
  );
  assert.equal(record.turns[0]!.passed, false);
  assert.match(record.turns[0]!.checks[0]!.detail, /Busan/);
}

// A reasoning trace is not the answer, and the answer behind it is scored.
{
  const record = await runScenario(
    toolScenario,
    scripted([
      '<think>maybe send_email? no, they asked about weather</think>\n{"tool":"get_weather","arguments":{"city":"Seoul","day":"tomorrow"}}',
      '<think>the result says snow</think>Snow, around 3C.',
    ]),
  );
  assert.equal(record.passed, true, 'the rehearsal is not what gets marked');
}

// A provider that throws leaves a failed turn with the reason on it.
{
  const record = await runScenario(toolScenario, async () => {
    throw new Error('HTTP 503');
  });
  assert.equal(record.passed, false);
  assert.equal(record.turns[0]!.error, 'HTTP 503');
  assert.deepEqual(record.turns[0]!.checks, [], 'nothing was scored');
}

// Text scenarios: an instruction dropped at turn three is a turn-three failure.
{
  const suffix = scenarios.find((s) => s.id === 'mt-en-suffix')!;
  const record = await runScenario(
    suffix,
    scripted(['OK\nDONE', 'Paris.\nDONE', 'Tokyo.', 'The Shinano river.\nDONE']),
  );
  assert.equal(record.passed, false);
  assert.equal(record.firstFailedTurn, 3, 'the turn that dropped it is named');
  assert.equal(record.turns[3]!.passed, true, 'later turns are still scored');
}

// The report cuts the same turns by capability and by depth.
{
  const report = await runMultiTurnHarness({
    modelId: 'scripted',
    scenarios: [toolScenario],
    caller: scripted([
      '{"tool":"get_weather","arguments":{"city":"Seoul","day":"tomorrow"}}',
      'Snow tomorrow.',
    ]),
  });
  assert.equal(report.schema, 'redrob-multi-turn/v1');
  assert.equal(report.scenarioPassRate, 1);
  assert.equal(report.turnPassRate, 1);
  assert.deepEqual(
    report.byCapability.map((c) => c.capability),
    ['tool_call', 'tool_use_result'],
  );
  assert.deepEqual(report.byDepth.map((d) => d.turn), [1, 2]);
  assert.equal(report.callErrors, 0);
  assert.equal(report.latencyMs.p50, 5);
}

// Depth is where the interesting number is: same model, worse the deeper it goes.
{
  const suffix = scenarios.find((s) => s.id === 'mt-en-suffix')!;
  const report = await runMultiTurnHarness({
    modelId: 'forgetful',
    scenarios: [suffix],
    caller: scripted(['OK\nDONE', 'Paris.\nDONE', 'Tokyo.', 'The Shinano river.']),
  });
  assert.equal(report.byDepth.find((d) => d.turn === 1)?.passRate, 1);
  assert.equal(report.byDepth.find((d) => d.turn === 4)?.passRate, 0);
  assert.equal(report.scenariosPassed, 0);
}

console.log('verify-multi-turn: all checks passed');
