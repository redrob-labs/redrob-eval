/**
 * Offline unit tests for the vLLM host registry.
 * Run: yarn test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeBaseUrl } from '../../apps/web/src/lib/settings/vllm-hosts.ts';

test('a bare origin gets the OpenAI path appended', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8000'), 'http://127.0.0.1:8000/v1');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8000/'), 'http://127.0.0.1:8000/v1');
});

test('an explicit path is kept, without a trailing slash', () => {
  assert.equal(normalizeBaseUrl('https://gpu.example.com/v1/'), 'https://gpu.example.com/v1');
  assert.equal(
    normalizeBaseUrl('https://gpu.example.com/proxy/vllm'),
    'https://gpu.example.com/proxy/vllm',
  );
});

test('query and fragment are dropped so two spellings cannot collide', () => {
  assert.equal(normalizeBaseUrl('http://host:8000/v1?token=x#frag'), 'http://host:8000/v1');
});

test('non-http schemes are refused', () => {
  for (const bad of ['file:///etc/passwd', 'ftp://host/v1', 'ws://host/v1']) {
    assert.throws(() => normalizeBaseUrl(bad), /must be http or https/);
  }
});

test('nonsense input is refused rather than stored', () => {
  assert.throws(() => normalizeBaseUrl('not a url'), /Not a valid URL/);
  assert.throws(() => normalizeBaseUrl('   '), /required/);
});
