/**
 * Offline checks for the fixed-toolset SLM routing harness.
 * No GPU / network / tokenizer download required.
 */
import assert from 'node:assert/strict';
import {
  FERTILITY_BASELINE_ID,
  TOOL_ROUTING_COMPARE_CONDITIONS,
  TOOL_ROUTING_CONDITIONS,
  TOOL_ROUTING_MODELS,
  argsExactEqual,
  buildConditionDeltas,
  buildToolRoutingPrompt,
  buildToolRoutingReport,
  listDefaultToolRoutingModels,
  loadStubToolRoutingTasks,
  loadStubToolsets,
  parseToolRoutingPrediction,
  scoreToolRoutingExample,
  aggregateSlice,
  validateToolRoutingTasks,
} from '@redrob/harness';

// Registry: every row has a license; eval_only stays out of the default set.
for (const m of TOOL_ROUTING_MODELS) {
  assert.ok(m.license, m.id);
  assert.ok(m.hfRepoId.includes('/'), m.id);
}
const defaults = listDefaultToolRoutingModels();
assert.ok(defaults.every((m) => m.usable === true));
assert.ok(!defaults.some((m) => m.id.startsWith('hammer')));
assert.ok(!defaults.some((m) => m.id.startsWith('xlam')));
// The non-commercial rows (Hammer, xLAM) are eval_only and never default.
assert.ok(
  TOOL_ROUTING_MODELS.filter((m) => m.usable === 'eval_only').length >= 2,
);
assert.ok(
  TOOL_ROUTING_MODELS.filter((m) => m.usable === true).length >= 10,
  'the default run set should be a real field of sub-10B models',
);
// Every id is unique and every repo id looks like org/name.
assert.equal(
  new Set(TOOL_ROUTING_MODELS.map((m) => m.id)).size,
  TOOL_ROUTING_MODELS.length,
);
assert.ok(TOOL_ROUTING_MODELS.some((m) => m.id === FERTILITY_BASELINE_ID));
assert.ok(TOOL_ROUTING_MODELS.some((m) => m.hybridSsm));

// Stub fixtures load and cover all four language constraints.
const tasks = loadStubToolRoutingTasks();
assert.ok(tasks.length >= 6);
const langs = new Set(tasks.map((t) => t.language));
assert.ok(langs.has('en') && langs.has('hi') && langs.has('hi-Latn') && langs.has('ko'));

// Fixture integrity. Every expected value has to be answerable from the prompt,
// or a bigger set just adds tasks that cap argument accuracy for the fixture's
// own reasons. The set is also balanced across languages, because a per-language
// slice with a different N is not a fair comparison.
const problems = validateToolRoutingTasks(tasks, loadStubToolsets());
assert.deepEqual(
  problems.map((p) => `${p.taskId}: ${p.message}`),
  [],
  'tool-routing fixtures have integrity problems',
);
const perLang = new Map<string, number>();
for (const t of tasks) perLang.set(t.language, (perLang.get(t.language) ?? 0) + 1);
const counts = [...perLang.values()];
assert.ok(
  counts.every((n) => n === counts[0]),
  `languages are unbalanced: ${[...perLang.entries()].map(([l, n]) => `${l}=${n}`).join(', ')}`,
);
// Big enough to slice by language and condition without single-digit cells.
assert.ok(tasks.length >= 300, `expected a paper-sized set, got ${tasks.length}`);
const absence = tasks.filter((t) => t.expected.kind === 'absence');
assert.ok(absence.length >= 40, `too few absence cases (${absence.length}) to measure BLOCK/DEFER`);

// Parse + score
const callPred = parseToolRoutingPrediction(
  'Sure.\n{"tool":"get_weather","arguments":{"city":"Seoul","day":"tomorrow"}}\n',
);
assert.equal(callPred.kind, 'call');
if (callPred.kind === 'call') {
  assert.equal(callPred.tool, 'get_weather');
  assert.ok(argsExactEqual(callPred.arguments, { day: 'tomorrow', city: 'Seoul' }));
}

const blockPred = parseToolRoutingPrediction('{"action":"BLOCK"}');
assert.equal(blockPred.kind, 'absence');

const bad = parseToolRoutingPrediction('not json at all');
assert.equal(bad.kind, 'parse_error');

const scored = scoreToolRoutingExample({
  expected: { kind: 'call', tool: 'get_weather', arguments: { city: 'Seoul', day: 'tomorrow' } },
  prediction: callPred,
  latencyGpuMs: 42,
});
assert.equal(scored.toolSelectCorrect, true);
assert.equal(scored.argExactMatch, true);
assert.equal(scored.latencyCpuMs, null);
assert.equal(scored.latencyGpuMs, 42);

const absenceScored = scoreToolRoutingExample({
  expected: { kind: 'absence', action: 'DEFER' },
  prediction: parseToolRoutingPrediction('{"action":"BLOCK"}'),
  latencyGpuMs: 10,
});
assert.equal(absenceScored.absenceCorrect, false);
assert.equal(absenceScored.toolSelectCorrect, null);

// Prompts differ by condition
const tools = tasks[0]!.tools;
const bare = buildToolRoutingPrompt({ condition: 'bare', user: 'hi', tools });
const contract = buildToolRoutingPrompt({ condition: 'contract', user: 'hi', tools });
assert.ok(!bare.includes('"action":"BLOCK"'));
assert.ok(contract.includes('"action":"BLOCK"'));
assert.ok(contract.includes('"action":"DEFER"'));

// Legacy experiments can still compare prompts; Compare itself runs contract only.
assert.deepEqual(TOOL_ROUTING_CONDITIONS, ['bare', 'contract']);
assert.deepEqual(TOOL_ROUTING_COMPARE_CONDITIONS, ['contract']);

// The wide toolset is a superset, and it is the one with the distractors.
const toolsets = loadStubToolsets();
assert.ok(toolsets.wide.length > toolsets.core.length);
const wideNames = new Set(toolsets.wide.map((t) => t.name));
assert.ok(toolsets.core.every((t) => wideNames.has(t.name)));

const slice = aggregateSlice({
  condition: 'bare',
  language: 'en',
  scores: [scored],
});
const report = buildToolRoutingReport({
  modelId: 'qwen3-0.6b',
  hfRepoId: 'Qwen/Qwen3-0.6B',
  slices: [
    slice,
    aggregateSlice({ condition: 'contract', language: 'en', scores: [scored] }),
  ],
});
assert.equal(report.schema, 'redrob-tool-routing/v2');
assert.deepEqual(report.languageConstraints, ['en']);
assert.ok(report.deltas.length >= 1);
const deltas = buildConditionDeltas(report.slices);
assert.equal(deltas[0]!.contractMinusBare.toolSelectAccuracy, 0);

console.log('verify:tool-routing ok');
