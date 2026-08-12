// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * The Python bridge must degrade, not explode.
 * Run: yarn test
 *
 * Generation is optional: `yarn install && yarn dev` has to work on a machine with no
 * Python at all. So a missing interpreter is an expected state that the bridge reports as
 * `available: false` with an actionable message, and these tests pin that behaviour by
 * pointing the client at a command that certainly does not exist.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_COMMAND,
  probePythonBridge,
  verifyWithPython,
} from '../../packages/harness/src/generate/index';

const ABSENT = 'redrob-generate-does-not-exist-9d3f';

test('the default command is the CLI, not an interpreter path', () => {
  assert.equal(DEFAULT_COMMAND, 'redrob-generate');
});

test('probing an absent command reports unavailable instead of throwing', async () => {
  const outcome = await probePythonBridge({ command: ABSENT });
  assert.equal(outcome.available, false);
  assert.ok(outcome.available === false && outcome.reason.includes(ABSENT));
  assert.ok(
    outcome.available === false && outcome.reason.includes('pip install -e packages/generate'),
    'the message must tell a human what to do about it',
  );
});

test('an absent command carries a code, so the UI can say it in any language', async () => {
  const outcome = await probePythonBridge({ command: ABSENT });
  assert.ok(outcome.available === false && outcome.reasonCode === 'not-found');
  assert.ok(outcome.available === false && outcome.command === ABSENT);
});

test('verifying with an absent command reports unavailable instead of throwing', async () => {
  const outcome = await verifyWithPython(
    { setDirectory: 'spec/conformance/example-set', outputsPath: '/dev/null' },
    { command: ABSENT },
  );
  assert.equal(outcome.available, false);
  assert.ok(outcome.available === false && outcome.reason.includes('not found on PATH'));
});

test('a command that produces no JSON is a bridge failure, not a silent pass', async () => {
  const outcome = await verifyWithPython(
    { setDirectory: 'spec/conformance/example-set', outputsPath: '/dev/null' },
    { command: 'true' },
  );
  assert.equal(outcome.available, false);
  assert.ok(outcome.available === false && outcome.reason.includes('no output'));
});

test('non-JSON output is reported rather than parsed optimistically', async () => {
  const outcome = await verifyWithPython(
    { setDirectory: 'spec/conformance/example-set', outputsPath: '/dev/null' },
    { command: 'echo' },
  );
  assert.equal(outcome.available, false);
  assert.ok(
    outcome.available === false &&
      (outcome.reason.includes('not JSON') || outcome.reason.includes('no output')),
  );
});
