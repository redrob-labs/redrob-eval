/**
 * Offline video / checklist verify — frame_policy, QWK, rubric lint, abstention.
 * Run: yarn verify:video
 */
import {
  abstentionRate,
  appendAnchorBlock,
  buildCustomGoalSpec,
  buildOptimizeReport,
  defaultFramePolicy,
  fitFramesToBudget,
  isAbstention,
  lintChecklistRubric,
  qwkFromPairs,
  reportToMarkdown,
  sampleEventDetect,
  sampleMotionEnergy,
  sampleUniform,
  seedCandidate,
  systemAwareMerge,
  tokensPerFrameToPixels,
  type EvalBatch,
  type FrameBuffer,
} from '../packages/harness/src/index';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function batch(
  quality: number,
  tokens: number,
  demosReq = 2,
  demosFit = 2,
  framesReq = 8,
  framesFit = 8,
): EvalBatch {
  return {
    quality,
    meanRelativeCost: 40,
    promptTokens: Math.floor(tokens / 2),
    completionTokens: Math.ceil(tokens / 2),
    totalTokens: tokens,
    latencyP50: 100,
    demosRequested: demosReq,
    demosFitted: demosFit,
    framesRequested: framesReq,
    framesFitted: framesFit,
    abstentionRate: 0.25,
    outcomes: [{ exampleId: 'e0', score: quality, feedback: 'ok' }],
  };
}

function syntheticFrames(n: number): FrameBuffer[] {
  const frames: FrameBuffer[] = [];
  for (let i = 0; i < n; i++) {
    const luma = new Float32Array(16);
    // Spike motion around index 10 and 20
    const energy = i === 10 || i === 20 ? 1 : i * 0.01;
    for (let j = 0; j < 16; j++) luma[j] = energy + j * 0.001;
    frames.push({ index: i, luma });
  }
  return frames;
}

async function main(): Promise<void> {
  console.log('=== frame_policy sampling ===');
  const frames = syntheticFrames(32);
  const uni = sampleUniform(32, 8);
  assert(uni.length === 8, 'uniform 8');
  assert(uni[0] === 0 && uni[uni.length - 1] === 31, 'uniform spans ends');
  const motion = sampleMotionEnergy(frames, 4);
  assert(motion.length === 4, 'motion energy 4');
  assert(motion.includes(10) || motion.includes(20), 'motion prefers peaks');
  const ev = sampleEventDetect(frames, 4, frames.map((_, i) => (i === 15 ? 9 : 0)));
  assert(ev.includes(15), 'event_detect respects scores');
  const fitted = fitFramesToBudget({
    policy: defaultFramePolicy({ strategy: 'uniform', n_frames: 16, tokens_per_frame: 640 }),
    frames,
    maxVisualTokens: 640 * 4,
  });
  assert(fitted.framesRequested === 16, 'requested 16');
  assert(fitted.framesFitted === 4, 'fitted under visual budget');
  const pix = tokensPerFrameToPixels(640);
  assert(pix.max_pixels === 640 * 28 * 28, 'pixels mapping');
  console.log('ok\n');

  console.log('=== genome framePolicy merge/report ===');
  const seed = seedCandidate({
    instruction: 'Score solder joints with binary checks.',
    demos: [],
    model: { modelId: 'test/vl', providerId: 'openrouter', relativeCostWeight: 30 },
    framePolicy: { strategy: 'uniform', n_frames: 8, tokens_per_frame: 640 },
    framesRequested: 8,
  });
  assert(seed.framePolicy?.strategy === 'uniform', 'seed frame policy');
  const other = seedCandidate({
    instruction: 'Alt',
    demos: [],
    model: { modelId: 'test/vl2', providerId: 'openrouter', relativeCostWeight: 80 },
    framePolicy: { strategy: 'motion_energy', n_frames: 4, tokens_per_frame: 256 },
  });
  const merged = systemAwareMerge(seed, other);
  assert(merged.framePolicy != null, 'merge keeps framePolicy');
  assert(
    (merged.framePolicy!.n_frames * merged.framePolicy!.tokens_per_frame) <=
      8 * 640,
    'merge prefers cheaper frame gene',
  );

  const report = buildOptimizeReport({
    runId: '2026-07-30_verify_video',
    qualityFloor: 0.6,
    datasetId: 'custom-checklist',
    optimizer: 'gepa',
    baseline: seed,
    baselineVal: batch(0.55, 200, 0, 0, 8, 8),
    evolved: { ...seed, id: 'ev1', framePolicy: { strategy: 'motion_energy', n_frames: 4, tokens_per_frame: 256 } },
    evolvedVal: batch(0.72, 100, 0, 0, 4, 4),
    frontier: [],
  });
  assert(report.frames.baselineRequested === 8, 'report frames requested');
  assert(report.frames.evolvedFitted === 4, 'report frames fitted');
  const md = reportToMarkdown(report);
  assert(md.includes('Frames requested/fitted'), 'markdown frames line');
  assert(!/\$|USD|dollar/i.test(md), 'no currency');
  console.log('ok\n');

  console.log('=== qwk + abstention ===');
  const perfect = qwkFromPairs(['0', '1', '2', '3'], ['0', '1', '2', '3']);
  assert(perfect.score === 1, 'perfect QWK');
  const withAbstain = qwkFromPairs(
    ['0', '1', '2', '3'],
    ['0', '1', 'ABSTAIN', '3'],
  );
  assert(withAbstain.score === 1, 'abstain excluded from QWK');
  assert(withAbstain.abstained === 1, 'counted abstention');
  assert(isAbstention('ABSTAIN'), 'isAbstention');
  const rate = abstentionRate(['1', 'ABSTAIN', '{"abstain":true}', '2']);
  assert(Math.abs(rate.score - 0.5) < 1e-9, 'abstention rate 0.5');
  console.log('ok\n');

  console.log('=== rubric lint ===');
  const badWhy = lintChecklistRubric('Tell me why did the joint fail.');
  assert(!badWhy.ok, 'why did should flag');
  assert(badWhy.warnings.some((w) => w.pattern === 'why_did'), 'why_did pattern');
  const badRate = lintChecklistRubric('Please rate from 1 to 10 the overall quality score.');
  assert(!badRate.ok, 'rate 1-10 should flag');
  const good = lintChecklistRubric(
    'Did the operator remove heat before the joint cooled? 0/1. Did flux fully wet the pad? 0/1.',
  );
  assert(good.ok, 'decomposed checklist should pass');
  console.log('ok\n');

  console.log('=== checklist custom goal + anchors ===');
  const spec = buildCustomGoalSpec({
    mode: 'checklist',
    goal: 'Score a hand-soldering clip against process checks.',
    rubric: 'Item1: tip cleaned? Item2: heat removed before cool?',
    examplesRaw: JSON.stringify([
      { id: 'c1', input: '{"kind":"video_frames","framePaths":["/tmp/a.png"]}', gold: '2' },
      { id: 'c2', input: '{"kind":"video_frames","framePaths":["/tmp/b.png"]}', gold: '3' },
      { id: 'c3', input: '{"kind":"video_frames","framePaths":["/tmp/c.png"]}', gold: '1' },
    ]),
    anchors: [
      { label: 'beginner', framePaths: ['/tmp/beg1.png'] },
      { label: 'skilled', framePaths: ['/tmp/sk1.png'] },
    ],
  });
  assert(spec.mode === 'checklist', 'checklist mode');
  assert(spec.rubricLint.ok, 'good rubric');
  const withAnchors = appendAnchorBlock('Judge carefully.', spec.anchors);
  assert(withAnchors.includes('Reference anchors'), 'anchors appended');
  assert(withAnchors.includes('beginner'), 'anchor label kept');
  console.log('ok\n');

  console.log('Video / checklist verify passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
