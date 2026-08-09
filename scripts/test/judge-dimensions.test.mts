// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * Reading a rubric's dimensions, and the judge's verdict on each.
 *
 * People write rubrics as a list of named criteria out of ten — "Readability (1-10)",
 * "Accuracy (1-10)" — and used to get back one number between 0 and 1. That number
 * cannot say accuracy is fine and calibration is what is dragging, which is the only
 * part anyone can act on. These tests cover both halves: finding the names in prose the
 * user already wrote, and keeping only what the rubric actually asked for.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  buildJudgePrompt,
  parseJudgeResponseForTest,
  rubricDimensions,
} from '../../packages/harness/src/lib/metrics/llm-judge';

const RUBRIC = [
  'Score each dimension from 1 to 10, average them, then divide by 10.',
  '',
  '- Readability (1-10): plain language, short paragraphs.',
  '- Accuracy (1-10): every claim traces to the profiles.',
  '- Balance (1-10): names what fits and what will grate.',
  '- Actionability (1-10): concrete things this pair could try.',
  '- Calibration (1-10): says where the evidence is thin.',
  '',
  'Hard cap: 0.4 if the report invents biographical facts.',
].join('\n');

test('finding the dimensions in a rubric', async (t) => {
  await t.test('reads the list a person would actually write', () => {
    assert.deepEqual(rubricDimensions(RUBRIC), [
      'Readability',
      'Accuracy',
      'Balance',
      'Actionability',
      'Calibration',
    ]);
  });

  await t.test('accepts numbered lists, en dashes and square brackets', () => {
    assert.deepEqual(
      rubricDimensions('1. Clarity [1-5]: is it clear?\n2) Tone (1–10): warm enough?'),
      ['Clarity', 'Tone'],
    );
  });

  await t.test('finds nothing in a rubric that names no dimensions', () => {
    // The catalog-dataset case, and the common case for a first-draft rubric. Nothing is
    // invented from prose: an empty list means one overall score, exactly as before.
    assert.deepEqual(rubricDimensions('Be accurate and readable. Prefer short sentences.'), []);
  });

  await t.test('does not repeat a dimension mentioned twice', () => {
    assert.deepEqual(rubricDimensions('- Tone (1-10): warm\n- Tone (1-10): still warm'), ['Tone']);
  });
});

test('the judge prompt', async (t) => {
  await t.test('asks for each dimension by name when the rubric names them', () => {
    const prompt = buildJudgePrompt({
      goal: 'g',
      rubric: RUBRIC,
      input: 'i',
      prediction: 'p',
      dimensions: rubricDimensions(RUBRIC),
    });
    assert.match(prompt, /"Readability":<number 1 to 10>/);
    assert.match(prompt, /"Calibration":<number 1 to 10>/);
    assert.match(prompt, /"score":<number 0 to 1>/);
  });

  await t.test('asks only for one score when it has no dimensions', () => {
    const prompt = buildJudgePrompt({ goal: 'g', rubric: 'be good', input: 'i', prediction: 'p' });
    assert.doesNotMatch(prompt, /dimensions/);
    assert.match(prompt, /"score":<number 0 to 1>/);
  });
});

test('reading the judge reply', async (t) => {
  const names = rubricDimensions(RUBRIC);

  await t.test('normalises each dimension from out-of-ten to a fraction', () => {
    const r = parseJudgeResponseForTest(
      '{"dimensions":{"Readability":8,"Accuracy":5,"Balance":7,"Actionability":3,"Calibration":2},' +
        '"score":0.5,"feedback":"generic advice"}',
      names,
    );
    assert.equal(r.score, 0.5);
    assert.equal(r.dimensions?.Readability, 0.8);
    assert.equal(r.dimensions?.Calibration, 0.2);
  });

  await t.test('falls back to the mean when the judge forgets the overall score', () => {
    // Everything needed has been said: the rubric's own instruction is to average them.
    const r = parseJudgeResponseForTest(
      '{"dimensions":{"Readability":10,"Accuracy":5},"feedback":"ok"}',
      ['Readability', 'Accuracy'],
    );
    assert.equal(r.score, 0.75);
  });

  await t.test('ignores dimensions the rubric never asked for', () => {
    // A judge inventing a criterion is a judge scoring something the reader did not
    // choose, and it would sit in the breakdown as though they had.
    const r = parseJudgeResponseForTest(
      '{"dimensions":{"Accuracy":9,"Vibes":10},"score":0.9,"feedback":"ok"}',
      ['Accuracy'],
    );
    assert.deepEqual(Object.keys(r.dimensions ?? {}), ['Accuracy']);
  });

  await t.test('matches dimension names regardless of case', () => {
    const r = parseJudgeResponseForTest(
      '{"dimensions":{"accuracy":6},"score":0.6,"feedback":"ok"}',
      ['Accuracy'],
    );
    assert.equal(r.dimensions?.Accuracy, 0.6);
  });

  await t.test('still reads a plain single-score reply', () => {
    const r = parseJudgeResponseForTest('{"score":0.42,"feedback":"thin"}');
    assert.equal(r.score, 0.42);
    assert.equal(r.dimensions, undefined);
  });

  await t.test('clamps a dimension the judge scored outside the scale', () => {
    const r = parseJudgeResponseForTest(
      '{"dimensions":{"Accuracy":14},"score":1,"feedback":"ok"}',
      ['Accuracy'],
    );
    assert.equal(r.dimensions?.Accuracy, 1);
  });
});
