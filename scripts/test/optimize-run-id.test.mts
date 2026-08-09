// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * Run ids have to survive several runs starting at once.
 *
 * The id was `date_HHMMSS_dataset`, which is unique while runs are started by one person
 * clicking one button. Racing three models starts them in the same tick: all three took
 * the same id, shared one directory and one entry in the jobs map, and all three event
 * streams reported the same run. The comparison table showed three identical rows —
 * 60.0% to 82.0% for every model, down to the token count — which reads as suspicious
 * rather than broken, and is exactly the kind of result that gets believed.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  assertSafeOptimizeRunId,
  makeOptimizeRunId,
} from '../../packages/harness/src/lib/jobs/optimize-fs';

test('optimize run ids', async (t) => {
  await t.test('differ when minted in the same tick', () => {
    const ids = new Set(Array.from({ length: 200 }, () => makeOptimizeRunId('custom-goal')));
    assert.equal(ids.size, 200, 'every id in a burst should be distinct');
  });

  await t.test('still start with a sortable timestamp', () => {
    assert.match(makeOptimizeRunId('gsm8k-main'), /^\d{4}-\d{2}-\d{2}_\d{6}_gsm8k-main-[a-z0-9]{4}$/);
  });

  await t.test('pass the path-safety check that guards the run directory', () => {
    for (const dataset of ['custom-goal', 'GSM8K (main)', '', '../../etc']) {
      const id = makeOptimizeRunId(dataset);
      assert.equal(assertSafeOptimizeRunId(id), id, `rejected its own id for ${dataset}`);
    }
  });

  await t.test('still refuse anything that could climb out of the runs directory', () => {
    for (const bad of ['../escape', 'a/b', '2026-08-09_070602_custom-goal/../..', '']) {
      assert.throws(() => assertSafeOptimizeRunId(bad), /Invalid optimize run id/);
    }
  });

  await t.test('accept ids minted before the suffix existed', () => {
    // Runs already on disk keep working: the directory name is the id.
    assert.equal(
      assertSafeOptimizeRunId('2026-08-09_055939_custom-goal'),
      '2026-08-09_055939_custom-goal',
    );
  });
});
