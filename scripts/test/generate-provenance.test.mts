// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * The Python-normative policy, from the display side.
 *
 * These tests assert that this implementation labels its own verdicts as
 * non-authoritative and cannot be talked out of it. They are the counterpart to the
 * Python tests that assert a publishable artifact refuses such a verdict: one side
 * applies the label, the other side acts on it, and neither is much use alone.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  IMPLEMENTATION,
  isAuthoritative,
  localProvenance,
  UNICODE_VERSION,
} from '../../packages/harness/src/generate/provenance';

test('provenance and the Python-normative policy', async (t) => {
  await t.test('a verdict produced here is marked non-authoritative', () => {
    const provenance = localProvenance('0.1.0');
    assert.equal(provenance.implementation, IMPLEMENTATION);
    assert.equal(provenance.implementation_version, '0.1.0');
    assert.equal(provenance.authoritative, false);
  });

  await t.test(
    'there is no argument that makes this side authoritative',
    () => {
      // Reads as a tautology and is not one. It is checking that `localProvenance` takes
      // no flag that flips `authoritative`, so the policy cannot be bypassed by a caller
      // who would rather it did not apply. If someone adds such a parameter later, the
      // shape assertion below is what notices.
      assert.deepEqual(Object.keys(localProvenance('x')).sort(), [
        'authoritative',
        'implementation',
        'implementation_version',
        'unicode_version',
      ]);
      assert.equal(
        localProvenance.length,
        1,
        'localProvenance takes only a version',
      );
    },
  );

  await t.test(
    'the Unicode version is read off the runtime, not asserted',
    () => {
      assert.equal(UNICODE_VERSION, process.versions.unicode ?? 'unknown');
      assert.match(UNICODE_VERSION, /^\d+\.\d+/);
    },
  );

  await t.test(
    'this runtime and CPython need not agree on the Unicode version',
    () => {
      // Not asserting that they differ -- that depends on which Node and which Python are
      // installed, and they may legitimately coincide. What is asserted is that the value
      // is a real reading, so an artifact recording both lets a reader check for
      // themselves rather than take the policy's word for it.
      assert.ok(UNICODE_VERSION.length > 0);
    },
  );

  await t.test(
    'a missing or malformed provenance block is not authoritative',
    () => {
      assert.equal(isAuthoritative(undefined), false);
      assert.equal(isAuthoritative(null), false);
      assert.equal(isAuthoritative({}), false);
      assert.equal(isAuthoritative({ authoritative: 'true' }), false);
      assert.equal(isAuthoritative({ authoritative: 1 }), false);
      assert.equal(isAuthoritative({ authoritative: true }), true);
    },
  );
});
