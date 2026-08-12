/**
 * Offline unit tests for tool-routing parse / metrics / registry.
 * Run: yarn test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateSlice,
  buildToolRoutingReport,
  listDefaultToolRoutingModels,
  loadStubToolCatalog,
  loadStubToolRoutingTasks,
  loadStubToolsets,
  measureToolRoutingFertility,
  normalizeToolRoutingLanguages,
  parseToolRoutingPrediction,
  scoreToolRoutingExample,
  toolRoutingBallotText,
  TOOL_ROUTING_CONDITIONS,
  TOOL_ROUTING_COMPARE_CONDITIONS,
  TOOL_ROUTING_DEFAULT_LANGUAGES,
  TOOL_ROUTING_LANGUAGES,
  TOOL_ROUTING_MODELS,
} from '../../packages/harness/src/lib/tool-routing/index.ts';
import { probeVllmEndpoint } from '../../packages/harness/src/lib/providers/vllm.ts';

test('default run set excludes eval_only models', () => {
  const defaults = listDefaultToolRoutingModels();
  assert.ok(defaults.every((m) => m.usable === true));
  assert.ok(TOOL_ROUTING_MODELS.some((m) => m.usable === 'eval_only'));
});

test('tool-routing languages default to every supported language', () => {
  assert.deepEqual(normalizeToolRoutingLanguages(undefined), TOOL_ROUTING_DEFAULT_LANGUAGES);
  assert.deepEqual(TOOL_ROUTING_DEFAULT_LANGUAGES, TOOL_ROUTING_LANGUAGES);
  assert.deepEqual(normalizeToolRoutingLanguages(['ko', 'en', 'ko']), ['ko', 'en']);
  assert.throws(() => normalizeToolRoutingLanguages([]), /at least one/);
  assert.throws(() => normalizeToolRoutingLanguages(['not-a-language']), /at least one/);
});

test('every language gets the same scenarios, so a slice compares language only', () => {
  const tasks = loadStubToolRoutingTasks();
  const byLanguage = new Map<string, string[]>();
  for (const task of tasks) {
    const scenario = task.id.slice(`${task.language}-`.length);
    byLanguage.set(task.language, [...(byLanguage.get(task.language) ?? []), scenario]);
  }

  assert.deepEqual(
    [...byLanguage.keys()].sort(),
    [...TOOL_ROUTING_LANGUAGES].sort(),
    'a language with no tasks produces an empty slice',
  );
  // Parallel translations: otherwise a per-language delta measures the wording
  // of the tasks as much as the language.
  const [first, ...rest] = [...byLanguage.values()].map((s) => s.sort());
  for (const other of rest) assert.deepEqual(other, first);
});

test('a scenario offers the same toolset in every language', () => {
  const toolsets = loadStubToolsets();
  const byScenario = new Map<string, string[]>();

  for (const task of loadStubToolRoutingTasks()) {
    const scenario = task.id.slice(`${task.language}-`.length);
    byScenario.set(scenario, [...(byScenario.get(scenario) ?? []), task.toolset]);
    // Otherwise the score would move with the distractor count, not the model.
    assert.equal(
      task.tools.length,
      toolsets[task.toolset].length,
      `${task.id} sees a toolset of its own`,
    );
  }

  for (const [scenario, sets] of byScenario) {
    assert.equal(new Set(sets).size, 1, `${scenario} changes toolset between languages`);
  }
});

test('the wide toolset keeps the core tools and adds near neighbours', () => {
  const { core, wide } = loadStubToolsets();
  const wideNames = new Set(wide.map((t) => t.name));
  for (const tool of core) {
    assert.ok(wideNames.has(tool.name), `${tool.name} disappears from the wide set`);
  }
  assert.ok(wide.length >= core.length * 2, 'wide is barely wider than core');
});

test('the full toolset has fifty tools and includes every wide tool', () => {
  const { wide, full } = loadStubToolsets();
  assert.equal(full.length, 50);
  const fullNames = new Set(full.map((t) => t.name));
  for (const tool of wide) {
    assert.ok(fullNames.has(tool.name), `${tool.name} disappears from the full set`);
  }
  assert.equal(loadStubToolCatalog().length, 50, 'the catalog lists every tool once');
});

test('fixtures exercise both absence actions and every core tool', () => {
  const tasks = loadStubToolRoutingTasks();
  const calledTools = new Set(
    tasks.flatMap((t) => (t.expected.kind === 'call' ? [t.expected.tool] : [])),
  );
  for (const tool of loadStubToolsets().core) {
    assert.ok(calledTools.has(tool.name), `${tool.name} is never the right answer`);
  }
  // The wide set exists to be distracting, so most of its extras must never win.
  const wideOnly = loadStubToolsets()
    .wide.filter((t) => !loadStubToolsets().core.some((c) => c.name === t.name))
    .map((t) => t.name);
  assert.ok(
    wideOnly.some((name) => !calledTools.has(name)),
    'every extra tool is an answer, so nothing is a distractor',
  );
  // The full set adds many domains; most of its extras must stay distractors too.
  const fullOnly = loadStubToolsets()
    .full.filter((t) => !loadStubToolsets().wide.some((w) => w.name === t.name))
    .map((t) => t.name);
  assert.ok(
    fullOnly.some((name) => !calledTools.has(name)),
    'every full-only tool is an answer, so nothing is a distractor',
  );

  const actions = new Set(
    tasks.flatMap((t) => (t.expected.kind === 'absence' ? [t.expected.action] : [])),
  );
  assert.deepEqual([...actions].sort(), ['BLOCK', 'DEFER']);
});

test('an expected call names a tool the task actually offered', () => {
  for (const task of loadStubToolRoutingTasks()) {
    const expected = task.expected;
    if (expected.kind !== 'call') continue;
    assert.ok(
      task.tools.some((t) => t.name === expected.tool),
      `${task.id} expects a tool it never showed the model`,
    );
  }
});

test('an expected call only asks for arguments the tool requires', () => {
  const required = new Map(
    loadStubToolCatalog().map((t) => [
      t.name,
      ((t.parameters as { required?: string[] }).required ?? []).slice().sort(),
    ]),
  );
  for (const task of loadStubToolRoutingTasks()) {
    if (task.expected.kind !== 'call') continue;
    // argsExactEqual is strict, so an expectation with a key the schema never
    // asked for could not be matched by any well-behaved model.
    assert.deepEqual(
      Object.keys(task.expected.arguments).sort(),
      required.get(task.expected.tool),
      `${task.id} expects arguments the schema does not require`,
    );
  }
});

test('parse accepts tool calls wrapped in prose', () => {
  const p = parseToolRoutingPrediction(
    'Here you go: {"tool":"get_weather","arguments":{"city":"Seoul","day":"tomorrow"}}',
  );
  assert.equal(p.kind, 'call');
});

test('a reasoning trace is not the answer, even when it rehearses one', () => {
  // Verbatim shape from LFM2.5-2.6B, whose template opens the block for it.
  const raw =
    'The user gave no city, so I cannot call get_weather.\n' +
    'I could answer {"tool":"get_weather","arguments":{"city":"Seoul","day":"today"}}' +
    ' but that invents a city, so use {"action":"DEFER"}.</think>{"action":"DEFER"}';
  const p = parseToolRoutingPrediction(raw);

  assert.equal(p.kind, 'absence', 'the draft inside the trace used to break the parse');
  if (p.kind === 'absence') assert.equal(p.action, 'DEFER');
  // The record keeps the answer, not the monologue: the trace is what the model
  // talked itself out of, and a results table full of it cannot be read.
  assert.equal(p.raw, '{"action":"DEFER"}');
});

test('a tool name in the action key is a parse failure that kept the call', () => {
  // Midm answers every tool task this way: right tool, right arguments, wrong
  // key. Strict scoring is the point of the contract condition, so it still
  // fails - but the report has to be able to say the routing was correct.
  const p = parseToolRoutingPrediction(
    '{"action":"get_weather","arguments":{"city":"Seoul","day":"2026-08-14"}}',
  );
  assert.equal(p.kind, 'parse_error');
  assert.equal(p.kind === 'parse_error' && p.envelope?.tool, 'get_weather');
  assert.deepEqual(p.kind === 'parse_error' ? p.envelope?.arguments : null, {
    city: 'Seoul',
    day: '2026-08-14',
  });

  const score = scoreToolRoutingExample({
    expected: {
      kind: 'call',
      tool: 'get_weather',
      arguments: { city: 'Seoul', day: '2026-08-14' },
    },
    prediction: p,
    latencyGpuMs: 12,
  });
  assert.equal(score.parseFailed, true, 'the contract asked for a shape it did not get');
  assert.equal(score.envelopeError, true);
  assert.equal(score.envelopeToolWouldMatch, true);
  assert.equal(score.toolSelectCorrect, null, 'a failed parse scores no accuracy');

  const slice = aggregateSlice({ condition: 'contract', language: 'en', scores: [score] });
  assert.equal(slice.parseFailureRate, 1);
  assert.deepEqual(slice.envelope, { errors: 1, toolWouldMatch: 1 });
});

test('an action that is neither absence nor a call stays a plain parse failure', () => {
  const p = parseToolRoutingPrediction('{"action":"maybe"}');
  assert.equal(p.kind, 'parse_error');
  assert.equal(p.kind === 'parse_error' && p.envelope, undefined);
  assert.match(p.kind === 'parse_error' ? p.message : '', /unknown action maybe/);
});

test('a reply that never left the thinking block has no answer to score', () => {
  const p = parseToolRoutingPrediction(
    '<think>Let me work through which tool applies here. First I should check',
  );
  assert.equal(p.kind, 'parse_error', 'a cut-off trace is not a tool call');
});

test('two objects in one reply resolve to the last complete one', () => {
  const p = parseToolRoutingPrediction(
    'Draft: {"tool":"lookup_order","arguments":{"order_id":"A-1"}}\n' +
      'Final: {"tool":"track_shipment","arguments":{"tracking_number":"1Z9"}}',
  );
  assert.equal(p.kind, 'call');
  if (p.kind === 'call') assert.equal(p.tool, 'track_shipment');
});

test('a brace inside a string never ends the object early', () => {
  const p = parseToolRoutingPrediction(
    '{"tool":"send_email","arguments":{"to":"a@b.io","subject":"} {","body":"\\" }"}}',
  );
  assert.equal(p.kind, 'call');
  if (p.kind === 'call') assert.equal(p.arguments.subject, '} {');
});

test('score separates absence from tool selection', () => {
  const s = scoreToolRoutingExample({
    expected: { kind: 'absence', action: 'BLOCK' },
    prediction: parseToolRoutingPrediction('{"action":"BLOCK"}'),
    latencyGpuMs: 5,
  });
  assert.equal(s.absenceCorrect, true);
  assert.equal(s.toolSelectCorrect, null);
  assert.equal(s.latencyCpuMs, null);
});

test('every model runs both conditions, since neither needs a server feature', () => {
  const report = buildToolRoutingReport({
    modelId: 'x',
    hfRepoId: 'org/x',
    languages: ['hi', 'hi-Latn'],
    slices: [],
  });
  assert.equal(report.schema, 'redrob-tool-routing/v2');
  assert.deepEqual(report.conditions, TOOL_ROUTING_CONDITIONS);
  assert.deepEqual(report.conditions, ['bare', 'contract']);
  assert.deepEqual(TOOL_ROUTING_COMPARE_CONDITIONS, ['contract']);
  assert.deepEqual(report.languageConstraints, ['hi', 'hi-Latn']);
});

test('Compare reports contract only and emits no meaningless bare delta', () => {
  const report = buildToolRoutingReport({
    modelId: 'x',
    languages: ['en'],
    conditions: TOOL_ROUTING_COMPARE_CONDITIONS,
    slices: [],
  });
  assert.deepEqual(report.conditions, ['contract']);
  assert.deepEqual(report.deltas, []);
});

test('a ballot shows the request and the tools, and never the expected answer', () => {
  const tasks = loadStubToolRoutingTasks();
  const task = tasks.find((x) => x.id === 'en-weather')!;
  const ballot = toolRoutingBallotText(task);

  assert.ok(ballot.startsWith(task.user), 'the request comes first');
  for (const tool of task.tools) {
    assert.ok(ballot.includes(`${tool.name}(`), `${tool.name} is missing from the ballot`);
  }
  // Optional parameters are marked, so a voter can tell a miss from a choice.
  assert.match(ballot, /translate_text\(text, target_language\)/);
  // A voter reading the key would be checking the grader, not judging the answer.
  const expected = task.expected as { tool: string; arguments: Record<string, unknown> };
  assert.ok(
    !ballot.includes(`"${expected.tool}"`),
    'the expected call must not be on the ballot',
  );
});

test('a tokenizer that will not load produces no number, not an estimate', async () => {
  const corpus = { en: 'a b c', hi: 'a b c', 'hi-Latn': 'a b c', ko: 'a b c' } as const;
  const cells = await measureToolRoutingFertility({
    corpus,
    models: [
      {
        id: 'unloadable',
        hfRepoId: 'org/unloadable',
        label: 'Unloadable',
        license: 'apache-2.0',
        usable: true,
      },
    ],
    countTokensImpl: async () => {
      throw new Error('Failed to load tokenizer for org/unloadable: offline');
    },
  });

  assert.equal(cells.length, 4);
  for (const c of cells) {
    assert.equal(c.measured, false);
    assert.equal(c.fertility, 0);
    assert.equal(c.tokens, 0);
    assert.equal(c.relativeToBaseline, null);
    assert.match(c.error ?? '', /Failed to load tokenizer/);
  }
});

test('fertility only measures selected languages', async () => {
  const corpus = { en: 'a b', hi: 'a b', 'hi-Latn': 'a b', ko: 'a b' } as const;
  const cells = await measureToolRoutingFertility({
    corpus,
    languages: ['hi', 'hi-Latn'],
    models: [
      {
        id: 'selected-only',
        hfRepoId: 'org/selected-only',
        label: 'Selected only',
        license: 'apache-2.0',
        usable: true,
      },
    ],
    countTokensImpl: async () => ({ tokens: 2, tokenizerId: 'test' }),
  });
  assert.deepEqual(cells.map((cell) => cell.language), ['hi', 'hi-Latn']);
});

test('probe reports a closed vLLM port as unreachable', async () => {
  const prevKey = process.env.VLLM_API_KEY;
  const prevUrl = process.env.VLLM_BASE_URL;
  process.env.VLLM_API_KEY = 'test-key';
  // Port 1 is reserved and never listening, so this is a refused connection.
  process.env.VLLM_BASE_URL = 'http://127.0.0.1:1/v1';
  try {
    const probe = await probeVllmEndpoint({ timeoutMs: 1500 });
    assert.equal(probe.configured, true);
    assert.equal(probe.reachable, false);
    assert.ok(probe.error);
  } finally {
    if (prevKey === undefined) delete process.env.VLLM_API_KEY;
    else process.env.VLLM_API_KEY = prevKey;
    if (prevUrl === undefined) delete process.env.VLLM_BASE_URL;
    else process.env.VLLM_BASE_URL = prevUrl;
  }
});
