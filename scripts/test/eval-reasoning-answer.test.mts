// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * What an eval reports when the model thinks before it answers.
 *
 * Found against LFM2.5 on a self-hosted host: the reply opened with `<think>`, the task
 * cap (512 for translation and math, 16 for classification) ran out inside the trace, and
 * the run recorded a truncated thought as the model's answer. Two separate faults come out
 * of that. The cap was ours, so cutting there measures the budget rather than the model;
 * and the trace is not the answer, so scoring it reads a rehearsal as a reply.
 *
 * The hosted escalation in the provider cannot catch this one: it keys off
 * `reasoning_tokens`, which a vLLM server does not report for an inline `<think>` block.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { REASONING_REPLY_MAX_TOKENS, replyMaxTokens } from '../../packages/harness/src/lib/eval/run';
import { maxTokensForTask } from '../../packages/harness/src/lib/eval/prompts';
import {
  parseToolRoutingPrediction,
  stripReasoning,
} from '../../packages/harness/src/lib/tool-routing/parse';

test('the reply budget for an eval call', async (t) => {
  await t.test('is left to the server on a self-hosted host', () => {
    // Nothing is billed per token here, and any finite number we pick is a number about
    // our guess at the trace length, not about the model.
    assert.equal(replyMaxTokens('vllm', maxTokensForTask('classification')), null);
    assert.equal(replyMaxTokens('vllm', maxTokensForTask('math')), null);
  });

  await t.test('leaves a hosted model room to think and then answer', () => {
    // 16 tokens is enough for the digit the classification prompt asks for and not enough
    // to reach it through a trace.
    for (const task of ['classification', 'translation', 'math', 'custom'] as const) {
      const cap = replyMaxTokens('openrouter', maxTokensForTask(task));
      assert.ok(
        cap != null && cap >= REASONING_REPLY_MAX_TOKENS,
        `${task} should clear the trace, got ${cap}`,
      );
    }
  });

  await t.test('never trims a task that already asks for more', () => {
    assert.equal(replyMaxTokens('openrouter', 99_999), 99_999);
  });
});

test('a reply that opens with a reasoning trace', async (t) => {
  await t.test('is scored on the answer, not on the thinking', () => {
    const raw = '<think>The user wants 2+2. Maybe 5? No, 4.</think>4';
    assert.equal(stripReasoning(raw), '4');
  });

  await t.test('has no answer behind it when the trace never closes', () => {
    // The distinction the run depends on: this is a cut-off call to report, not a wrong
    // answer to score.
    assert.equal(stripReasoning('<think>Counting the apples, so far'), '');
  });

  await t.test('leaves an ordinary reply untouched', () => {
    assert.equal(stripReasoning('4'), '4');
  });

  await t.test('is stripped when the template opened the trace, not the model', () => {
    // LFM2.5's chat template puts `<think>` in the generation prompt, so the
    // model only ever emits the closing tag and the trace arrives as content.
    const raw = 'The user wants 2+2.\nThe answer is 4.</think>4';
    assert.equal(stripReasoning(raw), '4');
  });
});

test('a tool-routing record shows the answer rather than the monologue', async (t) => {
  await t.test('keeps the trace out of the response cell', () => {
    const raw = 'I should call get_weather here.</think>{"tool":"get_weather","arguments":{"city":"Seoul"}}';
    const parsed = parseToolRoutingPrediction(raw);
    assert.equal(parsed.kind, 'call');
    assert.ok(!parsed.raw.includes('I should call'), 'the trace leaked into the record');
    assert.equal(parsed.raw, '{"tool":"get_weather","arguments":{"city":"Seoul"}}');
  });

  await t.test('still shows the reply when the trace never closed', () => {
    // Nothing to show otherwise, and an empty cell hides why the call failed.
    const raw = '<think>Still weighing the options';
    const parsed = parseToolRoutingPrediction(raw);
    assert.equal(parsed.kind, 'parse_error');
    assert.equal(parsed.raw, raw);
  });
});
