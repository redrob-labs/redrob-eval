/**
 * Provider extraBody passthrough for server-specific request fields.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { CallModelParams } from '../../packages/harness/src/lib/providers/types.ts';

test('CallModelParams passes server-specific fields through untouched', () => {
  const params: CallModelParams = {
    providerId: 'vllm',
    modelId: 'redrob',
    prompt: 'hi',
    extraBody: { chat_template_kwargs: { enable_thinking: false } },
  };
  assert.deepEqual(params.extraBody?.chat_template_kwargs, { enable_thinking: false });
});
