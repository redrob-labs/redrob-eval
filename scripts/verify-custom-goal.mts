/**
 * Offline custom-goal checks — parse, prompt, judge JSON (no provider calls).
 * Run: yarn verify:custom-goal
 */
import {
  buildCustomGoalSpec,
  buildEvalPrompt,
  buildJudgePrompt,
  defaultInstructionFromGoal,
  parseCustomExamples,
  parseJudgeResponseForTest,
} from '../packages/harness/src/index';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function main(): void {
  console.log('=== parseCustomExamples ===');
  const jsonl = [
    '{"id":"a","input":"Cand A vs Job X"}',
    '{"input":"Cand B vs Job Y"}',
    '{"id":"c","input":"Cand C vs Job Z"}',
  ].join('\n');
  const examples = parseCustomExamples(jsonl);
  assert(examples.length === 3, '3 examples');
  assert(examples[1]!.id === 'custom_2', 'auto id');

  const arr = parseCustomExamples(
    JSON.stringify([
      { input: 'one' },
      { input: 'two' },
      { input: 'three' },
    ]),
  );
  assert(arr.length === 3, 'array form');

  let threw = false;
  try {
    parseCustomExamples('{"input":"only one"}\n');
  } catch {
    threw = true;
  }
  assert(threw, 'too few examples should throw');
  console.log('ok\n');

  console.log('=== buildCustomGoalSpec + seed instruction ===');
  const spec = buildCustomGoalSpec({
    goal: 'Evaluate a hiring candidate against a job description.',
    rubric: 'Score clarity, evidence of skills, and absence of unfair bias. 0–1.',
    examplesRaw: jsonl,
  });
  assert(spec.goal.includes('hiring'), 'goal kept');
  const seed = defaultInstructionFromGoal(spec.goal);
  assert(seed.includes('hiring'), 'seed from goal');
  console.log('ok\n');

  console.log('=== custom prompt builder ===');
  const prompt = buildEvalPrompt('custom', 'Input payload here', {
    instruction: 'You are an interview evaluator.',
    demos: [],
  });
  assert(prompt.includes('You are an interview evaluator.'), 'instruction present');
  assert(prompt.includes('Input payload here'), 'input present');
  assert(!prompt.includes('Translate the following'), 'no fixed translate template');
  console.log('ok\n');

  console.log('=== judge JSON parse ===');
  const ok = parseJudgeResponseForTest(
    '```json\n{"score":0.75,"feedback":"Clear evidence of skills."}\n```',
  );
  assert(ok.score === 0.75, 'score parsed');
  assert(ok.feedback.includes('Clear'), 'feedback parsed');
  const bad = parseJudgeResponseForTest('not json');
  assert(bad.score === 0, 'bad json → 0');
  const judgePrompt = buildJudgePrompt({
    goal: spec.goal,
    rubric: spec.rubric,
    input: 'x',
    prediction: 'y',
  });
  assert(judgePrompt.includes('## Rubric'), 'judge prompt shaped');
  assert(judgePrompt.includes('Do NOT mention absolute prices'), 'currency policy present');
  console.log('ok\n');

  console.log('Custom goal verify passed.');
}

main();
