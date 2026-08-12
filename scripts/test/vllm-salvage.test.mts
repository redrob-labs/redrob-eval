// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * What a self-hosted reasoning model's reply becomes when the server splits it.
 *
 * With a vLLM reasoning parser on, the trace lands in `reasoning` and only the
 * text after it in `content`. A model that thinks and then never emits a
 * separate answer left `content` empty, and the harness turned that into
 * "Reasoning trace only, no answer" while discarding the trace. But a thinking
 * model rehearses its final JSON inside the trace, so the answer was there the
 * whole time. These tests pin the salvage: prefer content, fall back to the
 * trace, and only fail when both are empty.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { salvageReply } from '../../packages/harness/src/lib/providers/vllm.ts';
import {
  parseToolRoutingPrediction,
} from '../../packages/harness/src/lib/tool-routing/parse.ts';

test('salvageReply prefers the content answer when there is one', () => {
  assert.equal(salvageReply('  {"action":"DEFER"}  ', 'some trace', 'stop'), '{"action":"DEFER"}');
});

test('salvageReply hands back the trace when the model only thought', () => {
  const trace = 'I should defer here.\n{"action":"DEFER"}';
  assert.equal(salvageReply('', trace, 'stop'), trace);
  // And the tool-routing parser lifts the rehearsed JSON out of that trace.
  const parsed = parseToolRoutingPrediction(salvageReply('', trace, 'stop'));
  assert.equal(parsed.kind, 'absence');
});

test('salvageReply still fails when neither content nor trace exists', () => {
  assert.throws(() => salvageReply('', '', 'stop'), /Empty model response/);
  assert.throws(() => salvageReply('', '   ', 'length'), /cut off by token budget/);
});
