import test from 'node:test';
import assert from 'node:assert/strict';

import {
  referenceAnswerFromVerifier,
  referencesForInstances,
} from '../../apps/web/src/lib/generate/reference.ts';
import { COMPARE_IMAGE_UI_ENABLED } from '../../apps/web/src/lib/compare/features.ts';

test('exact verifier becomes an exact reference answer', () => {
  assert.deepEqual(
    referenceAnswerFromVerifier({ type: 'exact', expected: '{"answer":4}', trim: true }),
    { gold: '{"answer":4}', metric: 'accuracy' },
  );
});

test('numeric tolerance becomes a numeric exact-answer reference', () => {
  assert.deepEqual(
    referenceAnswerFromVerifier({
      type: 'numeric_tolerance',
      expected: 4.25,
      abs_tol: 0.0001,
    }),
    { gold: '4.25', metric: 'gsm8k_exact' },
  );
});

test('verifier list prefers its canonical exact check over a schema', () => {
  assert.deepEqual(
    referenceAnswerFromVerifier([
      { type: 'json_schema', schema: { type: 'object' } },
      { type: 'exact', expected: '{"city":"Seoul"}' },
    ]),
    { gold: '{"city":"Seoul"}', metric: 'accuracy' },
  );
});

test('format-only verifier does not invent one gold answer', () => {
  assert.equal(
    referenceAnswerFromVerifier({
      type: 'format_constraint',
      min_lines: 3,
      required_substrings: ['Release notes'],
    }),
    null,
  );
});

test('a set is scored only when every instance has the same reference metric', () => {
  assert.deepEqual(
    referencesForInstances([
      { verifier: { type: 'numeric_tolerance', expected: 2 } },
      { verifier: { type: 'numeric_tolerance', expected: 7 } },
    ]),
    {
      references: [
        { gold: '2', metric: 'gsm8k_exact' },
        { gold: '7', metric: 'gsm8k_exact' },
      ],
      metric: 'gsm8k_exact',
    },
  );
  assert.equal(
    referencesForInstances([
      { verifier: { type: 'exact', expected: 'x' } },
      { verifier: { type: 'numeric_tolerance', expected: 7 } },
    ]),
    null,
  );
});

test('image comparison is deliberately absent from the product surface', () => {
  assert.equal(COMPARE_IMAGE_UI_ENABLED, false);
});
