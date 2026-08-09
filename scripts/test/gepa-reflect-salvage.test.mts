// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * What the reflector does with a reply it cannot parse.
 *
 * Found on a live custom-goal run. The reflector is asked for
 * `{ lesson, instruction, ... }`; the instruction is the longest field, so the token cap
 * lands inside it and the object never closes. The old fallback used the whole raw reply
 * as the evolved instruction, which meant the prompt driving every later rollout — and
 * the evolved prompt the reader copies out at the end — began:
 *
 *     ```json
 *     {
 *       "lesson": "The model provides generic relationship advice…",
 *       "instruction": "Given two short profiles, write a compatibility report…
 *
 * Quality still climbed 46% to 62%, which is the uncomfortable part: the artifact was
 * visibly malformed and nothing downstream objected.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { __testables } from '../../packages/harness/src/lib/optimizer/gepa/reflect';

const { salvageInstruction, looksLikeJson } = __testables;

/** A reply cut off mid-instruction, exactly as the live run produced it. */
const TRUNCATED = [
  '```json',
  '{',
  '  "lesson": "The model gives generic advice and does not flag thin context.",',
  '  "instruction": "Given two short profiles, write a compatibility report.\\n\\n' +
    '1. Where They Click: overlapping strengths grounded in the profiles.\\n' +
    '2. Where They Grate: differing habits, fairly for both people.\\n' +
    '3. Tailored Action Protocols',
].join('\n');

test('a reflector reply that was cut off', async (t) => {
  await t.test('gives up its instruction rather than its JSON syntax', () => {
    const got = salvageInstruction(TRUNCATED);
    assert.ok(got, 'should recover something');
    assert.match(got, /^Given two short profiles/);
    assert.doesNotMatch(got, /```/, 'no fence in the recovered prompt');
    assert.doesNotMatch(got, /"lesson"/, 'no JSON keys in the recovered prompt');
  });

  await t.test('comes back with real newlines, not the escapes', () => {
    const got = salvageInstruction(TRUNCATED)!;
    assert.ok(got.includes('\n'), 'escaped newlines should be decoded');
    assert.doesNotMatch(got, /\\n/, 'no literal backslash-n left behind');
  });

  await t.test('is refused when the cut landed mid-escape', () => {
    // Half an escape sequence cannot be decoded, and guessing at it would put a stray
    // backslash into the prompt. Better to keep the parent instruction.
    assert.equal(salvageInstruction('{"instruction": "Write a report about the pair.\\'), null);
  });

  await t.test('is refused when there is barely anything there', () => {
    assert.equal(salvageInstruction('{"instruction": "Write'), null);
  });

  await t.test('is refused when the reply has no instruction field at all', () => {
    assert.equal(salvageInstruction('```json\n{"lesson": "be more specific"'), null);
  });
});

test('telling a JSON attempt from prose', async (t) => {
  await t.test('recognises a fence and a bare brace', () => {
    assert.equal(looksLikeJson('```json\n{"a":1}'), true);
    assert.equal(looksLikeJson('  {"a":1}'), true);
  });

  await t.test('lets plain prose through, which is still usable as an instruction', () => {
    assert.equal(looksLikeJson('You are a careful writer. Ground every claim.'), false);
  });
});
