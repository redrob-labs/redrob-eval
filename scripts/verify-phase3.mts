/**
 * Offline Phase 3 checks — script_policy, demos fit, report (no provider calls).
 * Run: yarn verify:phase3
 */
import {
  applyScriptPolicy,
  buildOptimizeReport,
  defaultScriptBundle,
  fitDemosToBudget,
  reportToMarkdown,
  resolveScriptPolicies,
  seedCandidate,
  systemAwareMerge,
  type EvalBatch,
} from '../packages/harness/src/index';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function batch(
  quality: number,
  tokens: number,
  demosReq = 2,
  demosFit = 2,
  meanRelativeCost = 50,
): EvalBatch {
  return {
    quality,
    meanRelativeCost,
    promptTokens: Math.floor(tokens / 2),
    completionTokens: Math.ceil(tokens / 2),
    totalTokens: tokens,
    latencyP50: 100,
    demosRequested: demosReq,
    demosFitted: demosFit,
    outcomes: [{ exampleId: 'e0', score: quality, feedback: 'ok' }],
  };
}

async function main(): Promise<void> {
  console.log('=== script_policy ===');
  const hi = 'नमस्ते दुनिया';
  const roman = applyScriptPolicy(hi, 'romanize');
  assert(roman !== hi, 'romanize should change Devanagari');
  assert(!/[\u0900-\u097F]/.test(roman), 'romanize should strip Devanagari');
  assert(applyScriptPolicy(hi, 'passthrough') === hi, 'passthrough keeps text');
  assert(applyScriptPolicy(hi, 'native') === hi, 'native keeps text');
  const back = applyScriptPolicy('namaste', 'normalize_to_native');
  assert(/[\u0900-\u097F]/.test(back), 'normalize_to_native should emit Devanagari');
  console.log('ok\n');

  console.log('=== candidate scriptPolicies ===');
  const seed = seedCandidate({
    instruction: 'Translate carefully.',
    demos: [
      { input: 'एक', output: 'one' },
      { input: 'दो', output: 'two' },
      { input: 'तीन', output: 'three' },
    ],
    model: { modelId: 'test/model', providerId: 'openrouter', relativeCostWeight: 40 },
    scriptPolicies: defaultScriptBundle('romanize'),
    maxPromptTokens: 80,
    demosRequested: 3,
  });
  assert(resolveScriptPolicies(seed).input === 'romanize', 'seed policies');
  const other = seedCandidate({
    instruction: 'Alt',
    demos: [{ input: 'x', output: 'y' }],
    model: { modelId: 'test/model2', providerId: 'openrouter', relativeCostWeight: 80 },
    scriptPolicies: defaultScriptBundle('native'),
  });
  const merged = systemAwareMerge(seed, other);
  assert(merged.scriptPolicies != null, 'merge keeps scriptPolicies');
  console.log('ok\n');

  console.log('=== demos_requested vs demos_fitted ===');
  const fit = await fitDemosToBudget({
    modelId: 'nonexistent/tokenizer-for-verify',
    task: 'translation',
    instruction: seed.instruction,
    demos: seed.demos,
    demosRequested: 3,
    sampleInput: 'चार',
    maxPromptTokens: 40,
    scriptPolicies: defaultScriptBundle('passthrough'),
  });
  assert(fit.demosRequested === 3, 'requested=3');
  assert(fit.demosFitted <= fit.demosRequested, 'fitted <= requested');
  assert(fit.demosFitted < 3, 'tight budget should drop demos');
  console.log(`fitted ${fit.demosFitted}/${fit.demosRequested} (measured=${fit.measured})`);
  console.log('ok\n');

  console.log('=== baseline vs evolved report ===');
  const baseline = seed;
  const evolved = {
    ...seed,
    id: 'evolved_1',
    instruction: 'Improved instruction.',
    model: { ...seed.model, relativeCostWeight: 25 },
  };
  const report = buildOptimizeReport({
    runId: '2026-01-01_000000_verify',
    qualityFloor: 0.5,
    datasetId: 'in22-gen-hi-en',
    optimizer: 'gepa',
    baseline,
    baselineVal: batch(0.6, 200, 3, 2, 40),
    evolved,
    evolvedVal: batch(0.7, 120, 3, 3, 25),
    frontier: [],
  });
  assert(report.tokenDelta === -80, 'token delta');
  assert(report.relativeCostPct != null && report.relativeCostPct < 100, 'cheaper relative cost');
  assert(!/\$|USD|dollar/i.test(reportToMarkdown(report)), 'no currency in markdown');
  console.log('ok\n');

  console.log('Phase 3 verify passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
