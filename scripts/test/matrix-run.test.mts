/**
 * The registry + queue glue.
 *
 * The point of this layer is that "run a grid" and "resume a grid" are one
 * call, and that a resume cannot quietly become a different experiment under the
 * same id. Those are what the tests pin.
 * Run: yarn test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  runRegistryMatrix,
  readMatrixCells,
} from '../../packages/harness/src/lib/matrix-run/index.ts';
import { FsRunStore } from '../../packages/harness/src/lib/registry/fs-store.ts';
import type { RunStore } from '../../packages/harness/src/lib/registry/types.ts';

async function withStore(fn: (store: RunStore) => Promise<void>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'redrob-matrix-'));
  const store = new FsRunStore(path.join(dir, 'registry'));
  try {
    await fn(store);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const dimensions = { model: ['a', 'b'], language: ['en', 'ko'] };

test('a grid becomes one registry run with a summary of its cells', async () => {
  await withStore(async (store) => {
    const ran: string[] = [];
    const { runId, run, result } = await runRegistryMatrix({
      store,
      kind: 'tool-routing-matrix',
      label: 'demo',
      models: ['a', 'b'],
      dimensions,
      async worker(cell) {
        const { model, language } = cell.params as { model: string; language: string };
        ran.push(`${model}/${language}`);
        return { model, language, score: 1 };
      },
    });
    assert.equal(result.done, 4);
    assert.equal(ran.length, 4, 'every cell ran once');
    const stored = await store.get(runId);
    assert.equal(stored?.status, 'done');
    assert.deepEqual(stored?.summary, { total: 4, done: 4, failed: 0, resumed: 0 });
    assert.equal(run.kind, 'tool-routing-matrix');
    // The per-cell numbers are readable back off the run.
    const cells = await readMatrixCells(store, runId);
    assert.equal(cells.length, 4);
    assert.ok(cells.every((c) => c.status === 'done' && c.summary));
  });
});

test('resuming reopens the run and runs only the cells left', async () => {
  await withStore(async (store) => {
    const controller = new AbortController();
    let count = 0;
    // First pass: abort after two cells.
    const first = await runRegistryMatrix({
      store,
      kind: 'tool-routing-matrix',
      dimensions,
      concurrency: 1,
      signal: controller.signal,
      async worker(cell) {
        count += 1;
        if (count === 2) controller.abort();
        const { model, language } = cell.params as { model: string; language: string };
        return { model, language };
      },
    });
    assert.ok(first.result.cancelled, 'the first pass was cancelled');
    assert.ok(first.result.done < 4);

    // Resume: same run id, only the unfinished cells run.
    const ranOnResume: string[] = [];
    const second = await runRegistryMatrix({
      store,
      kind: 'tool-routing-matrix',
      dimensions,
      resume: first.runId,
      async worker(cell) {
        ranOnResume.push(cell.key);
        const { model, language } = cell.params as { model: string; language: string };
        return { model, language };
      },
    });
    assert.equal(second.runId, first.runId, 'the resume reused the run, not a new one');
    assert.equal(second.result.done, 4, 'the grid is complete after resume');
    assert.equal(ranOnResume.length, 4 - first.result.done, 'only the remainder ran');
    const stored = await store.get(first.runId);
    assert.equal(stored?.status, 'done');
    // Every cell is present exactly once in the folded table.
    const cells = await readMatrixCells(store, first.runId);
    assert.equal(cells.length, 4);
    assert.equal(new Set(cells.map((c) => c.key)).size, 4);
  });
});

test('resuming a grid with different dimensions is refused', async () => {
  await withStore(async (store) => {
    const { runId } = await runRegistryMatrix({
      store,
      kind: 'tool-routing-matrix',
      dimensions,
      async worker(cell) {
        return cell.params;
      },
    });
    await assert.rejects(
      () =>
        runRegistryMatrix({
          store,
          kind: 'tool-routing-matrix',
          dimensions: { model: ['a', 'b', 'c'], language: ['en', 'ko'] },
          resume: runId,
          async worker(cell) {
            return cell.params;
          },
        }),
      /parameters differ/,
      'a resume that changed the grid must not silently proceed',
    );
  });
});

test('resuming an unknown run is refused', async () => {
  await withStore(async (store) => {
    await assert.rejects(
      () =>
        runRegistryMatrix({
          store,
          kind: 'tool-routing-matrix',
          dimensions,
          resume: '2026-01-01_000000_nope',
          async worker(cell) {
            return cell.params;
          },
        }),
      /no run with id/,
    );
  });
});

test('a grid with a failing cell still finishes and records the failure', async () => {
  await withStore(async (store) => {
    const { runId, result } = await runRegistryMatrix({
      store,
      kind: 'tool-routing-matrix',
      dimensions,
      maxAttempts: 1,
      async worker(cell) {
        const { model } = cell.params as { model: string };
        if (model === 'b') throw new Error('provider down');
        return cell.params;
      },
    });
    assert.equal(result.done, 2);
    assert.equal(result.failed, 2);
    const stored = await store.get(runId);
    // A grid with failed cells is still a finished run; the count is in summary.
    assert.equal(stored?.status, 'done');
    assert.deepEqual(stored?.summary, { total: 4, done: 2, failed: 2, resumed: 0 });
    const cells = await readMatrixCells(store, runId);
    const failed = cells.filter((c) => c.status === 'failed');
    assert.equal(failed.length, 2);
    assert.ok(failed.every((c) => c.error === 'provider down'));
  });
});
