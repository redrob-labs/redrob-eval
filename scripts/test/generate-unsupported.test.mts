// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * The executable tier must fail loudly in TypeScript.
 * Run: yarn test
 *
 * A verifier that is skipped and then reported as a success is the worst failure mode
 * this project has: every score computed from that run is inflated and nothing in the
 * output says so. These tests exist to make that failure impossible to introduce
 * accidentally, so they assert the error rather than the absence of a crash.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXECUTABLE_VERIFIER_TYPES,
  isDeclarative,
  isExecutable,
  runVerifier,
  runVerifierOrFail,
  UnsupportedVerifierError,
  type Verifier,
} from '../../packages/harness/src/generate/index';

const executableVerifiers: Record<string, Verifier> = {
  sympy_equiv: {
    type: 'sympy_equiv',
    expected_expression: 'x + 1',
    symbols: ['x'],
  } as unknown as Verifier,
  python_unittest: {
    type: 'python_unittest',
    test_source: 'import unittest\n',
  } as unknown as Verifier,
};

for (const verifierType of EXECUTABLE_VERIFIER_TYPES) {
  test(`runVerifier throws UnsupportedVerifierError for ${verifierType}`, () => {
    const verifier = executableVerifiers[verifierType] as Verifier;
    assert.throws(
      () => runVerifier(verifier, 'x + 1'),
      (error: unknown) => {
        assert.ok(
          error instanceof UnsupportedVerifierError,
          `expected UnsupportedVerifierError, got ${String(error)}`,
        );
        assert.equal(error.verifierType, verifierType);
        assert.match(error.message, /unsupported verifier type/);
        return true;
      },
    );
  });

  test(`runVerifierOrFail returns a failing verdict for ${verifierType}`, () => {
    const verdict = runVerifierOrFail(executableVerifiers[verifierType] as Verifier, 'x + 1');
    assert.equal(verdict.passed, false, 'an unsupported verifier must never report a pass');
    assert.equal(verdict.code, 'unsupported_verifier');
    assert.equal(verdict.detail?.verifier_type, verifierType);
  });

  test(`${verifierType} is classified as executable, not declarative`, () => {
    assert.equal(isExecutable(verifierType), true);
    assert.equal(isDeclarative(verifierType), false);
  });
}

test('an unknown verifier type is also an error, not a pass', () => {
  const verifier = { type: 'telepathy' } as unknown as Verifier;
  assert.throws(() => runVerifier(verifier, 'anything'), UnsupportedVerifierError);
  const verdict = runVerifierOrFail(verifier, 'anything');
  assert.equal(verdict.passed, false);
  assert.equal(verdict.code, 'unsupported_verifier');
});

test('a verifier with no type tag is an error, not a pass', () => {
  const verifier = { config: {} } as unknown as Verifier;
  assert.throws(() => runVerifier(verifier, 'anything'), UnsupportedVerifierError);
  assert.equal(runVerifierOrFail(verifier, 'anything').passed, false);
});
