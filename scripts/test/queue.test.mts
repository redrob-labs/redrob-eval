/**
 * The resumable job queue.
 *
 * The properties under test are the ones a researcher relies on without knowing
 * it: an interrupted grid resumes instead of re-running, one provider's rate
 * limit is never exceeded, a flaky cell is retried but a broken one is not
 * retried forever, one bad cell does not sink the grid, and a cancel leaves the
 * finished work intact and the rest genuinely unrun.
 * Run: yarn test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expandMatrix, runMatrix } from '../../packages/harness/src/lib/queue/index.ts';
import {
  MemoryCheckpoint,
  runStoreCheckpoint,
} from '../../packages/harness/src/lib/queue/checkpoint.ts';
import { FsRunStore } from '../../packages/harness/src/lib/registry/fs-store.ts';
import type { Cell } from '../../packages/harness/src/lib/queue/types.ts';

function cells(keys: string[], group?: (key: string) => string): Cell[] {
  return keys.map((key) => {
    const cell: Cell = { key, params: { key } };
    if (group) cell.group = group(key);
    return cell;
  });
}

const PINNED = {
  gitSha: 'test',
  gitDirty: false,
  runtime: { node: 'v22', platform: 'linux' },
};

test('a matrix is the cartesian product, with stable keys and a group', () => {
  const grid = expandMatrix({
    dimensions: { model: ['a', 'b'], lang: ['en', 'ko'] },
    groupBy: 'model',
  });
  assert.equal(grid.length, 4);
  assert.deepEqual(
    grid.map((c) => c.params),
    [
      { model: 'a', lang: 'en' },
      { model: 'a', lang: 'ko' },
      { model: 'b', lang: 'en' },
      { model: 'b', lang: 'ko' },
    ],
  );
  assert.deepEqual(grid.map((c) => c.group), ['a', 'a', 'b', 'b']);
  // Keys are a hash of the combo, so the same square keys the same next run.
  const again = expandMatrix({ dimensions: { model: ['a', 'b'], lang: ['en', 'ko'] } });
  assert.deepEqual(grid.map((c) => c.key), again.map((c) => c.key));
  assert.equal(new Set(grid.map((c) => c.key)).size, 4, 'keys are unique');
});

test('an empty dimension is refused rather than silently dropping the grid', () => {
  assert.throws(() => expandMatrix({ dimensions: { model: [] } }), /no values/);
});

test('every cell runs once and the summaries come back in cell order', async () => {
  const ran: string[] = [];
  const result = await runMatrix({
    cells: cells(['a', 'b', 'c']),
    concurrency: 2,
    async worker(cell) {
      ran.push(cell.key);
      return { got: cell.key };
    },
  });
  assert.equal(result.done, 3);
  assert.equal(result.failed, 0);
  assert.deepEqual(ran.sort(), ['a', 'b', 'c']);
  assert.deepEqual(
    result.outcomes.map((o) => o.summary),
    [{ got: 'a' }, { got: 'b' }, { got: 'c' }],
  );
});

test('global concurrency is never exceeded', async () => {
  let inflight = 0;
  let peak = 0;
  await runMatrix({
    cells: cells(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']),
    concurrency: 3,
    async worker() {
      inflight += 1;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 10));
      inflight -= 1;
    },
  });
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded the budget of 3`);
  assert.ok(peak >= 2, `budget of 3 never used more than one worker (peak ${peak})`);
});

test("a group's concurrency cap holds even when the global budget is higher", async () => {
  const inflight = new Map<string, number>();
  const peak = new Map<string, number>();
  const grid = cells(
    ['openrouter:1', 'openrouter:2', 'openrouter:3', 'vllm:1', 'vllm:2'],
    (key) => key.split(':')[0]!,
  );
  await runMatrix({
    cells: grid,
    concurrency: 8,
    perGroupConcurrency: 1,
    async worker(cell) {
      const g = cell.group!;
      const now = (inflight.get(g) ?? 0) + 1;
      inflight.set(g, now);
      peak.set(g, Math.max(peak.get(g) ?? 0, now));
      await new Promise((r) => setTimeout(r, 10));
      inflight.set(g, now - 1);
    },
  });
  assert.equal(peak.get('openrouter'), 1, 'openrouter ran more than one at a time');
  assert.equal(peak.get('vllm'), 1, 'vllm ran more than one at a time');
});

test('a transient failure is retried and then succeeds', async () => {
  let attempts = 0;
  const result = await runMatrix({
    cells: cells(['flaky']),
    maxAttempts: 3,
    backoffMs: () => 0,
    async worker(_cell, ctx) {
      attempts = ctx.attempt;
      if (ctx.attempt < 3) throw new Error('429');
      return 'ok';
    },
  });
  assert.equal(attempts, 3);
  assert.equal(result.done, 1);
  assert.equal(result.outcomes[0]!.attempts, 3);
});

test('a cell that always fails is recorded, not retried forever, and does not sink the grid', async () => {
  const result = await runMatrix({
    cells: cells(['ok1', 'broken', 'ok2']),
    maxAttempts: 2,
    backoffMs: () => 0,
    async worker(cell) {
      if (cell.key === 'broken') throw new Error('nope');
      return 'fine';
    },
  });
  assert.equal(result.done, 2);
  assert.equal(result.failed, 1);
  const broken = result.outcomes.find((o) => o.key === 'broken')!;
  assert.equal(broken.status, 'failed');
  assert.equal(broken.error, 'nope');
  assert.equal(broken.attempts, 2, 'tried exactly maxAttempts times');
  // The good cells still finished.
  assert.deepEqual(
    result.outcomes.filter((o) => o.status === 'done').map((o) => o.key).sort(),
    ['ok1', 'ok2'],
  );
});

test('resume skips the cells a checkpoint already has', async () => {
  const checkpoint = new MemoryCheckpoint();
  await checkpoint.record({ key: 'a', status: 'done', attempts: 1, resumed: false });
  await checkpoint.record({ key: 'b', status: 'done', attempts: 1, resumed: false });

  const ran: string[] = [];
  const result = await runMatrix({
    cells: cells(['a', 'b', 'c', 'd']),
    checkpoint,
    async worker(cell) {
      ran.push(cell.key);
      return 'x';
    },
  });
  assert.deepEqual(ran.sort(), ['c', 'd'], 'only the unfinished cells ran');
  assert.equal(result.resumed, 2);
  assert.equal(result.done, 4, 'resumed cells still count as done');
  assert.equal(
    result.outcomes.filter((o) => o.resumed).length,
    2,
    'the resumed cells are marked as such',
  );
});

test('a failed cell is not treated as done on the next run', async () => {
  const checkpoint = new MemoryCheckpoint();
  // First pass: one cell fails.
  await runMatrix({
    cells: cells(['a', 'b']),
    checkpoint,
    async worker(cell) {
      if (cell.key === 'b') throw new Error('down');
      return 'ok';
    },
  });
  // Second pass: the failed cell is retried, the done one is skipped.
  const ran: string[] = [];
  const result = await runMatrix({
    cells: cells(['a', 'b']),
    checkpoint,
    async worker(cell) {
      ran.push(cell.key);
      return 'ok';
    },
  });
  assert.deepEqual(ran, ['b'], 'the previously failed cell runs, the done one does not');
  assert.equal(result.done, 2);
});

test('cancelling leaves finished work recorded and the rest genuinely unrun', async () => {
  const controller = new AbortController();
  const checkpoint = new MemoryCheckpoint();
  const ran: string[] = [];
  const result = await runMatrix({
    cells: cells(['a', 'b', 'c', 'd', 'e', 'f']),
    concurrency: 1,
    checkpoint,
    signal: controller.signal,
    async worker(cell) {
      ran.push(cell.key);
      if (ran.length === 2) controller.abort();
      return 'ok';
    },
  });
  assert.ok(result.cancelled, 'the run reports it was cancelled');
  assert.ok(result.done >= 1 && result.done < 6, `expected a partial run, got ${result.done}`);
  // What finished is on the checkpoint; a resume runs only the remainder.
  const completed = await checkpoint.completedKeys();
  assert.equal(completed.size, result.done);
  const resumeRan: string[] = [];
  await runMatrix({
    cells: cells(['a', 'b', 'c', 'd', 'e', 'f']),
    checkpoint,
    async worker(cell) {
      resumeRan.push(cell.key);
      return 'ok';
    },
  });
  assert.equal(
    resumeRan.length,
    6 - completed.size,
    'the resume ran exactly the cells the cancel left behind',
  );
});

test('the registry-backed checkpoint resumes across store instances', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'redrob-queue-'));
  try {
    // First store instance: run the matrix, one cell fails.
    const store1 = new FsRunStore(path.join(dir, 'registry'));
    const run = await store1.create({ kind: 'matrix', params: {}, provenance: PINNED });
    await runMatrix({
      cells: cells(['a', 'b', 'c']),
      checkpoint: runStoreCheckpoint(store1, run.id),
      async worker(cell) {
        if (cell.key === 'c') throw new Error('boom');
        return 'ok';
      },
    });
    await store1.close();

    // A fresh store instance over the same directory, as a new process would
    // see it. Resume must run only 'c'.
    const store2 = new FsRunStore(path.join(dir, 'registry'));
    const ran: string[] = [];
    const result = await runMatrix({
      cells: cells(['a', 'b', 'c']),
      checkpoint: runStoreCheckpoint(store2, run.id),
      async worker(cell) {
        ran.push(cell.key);
        return 'ok';
      },
    });
    await store2.close();
    assert.deepEqual(ran, ['c'], 'only the cell that had failed ran on resume');
    assert.equal(result.done, 3);
    assert.equal(result.resumed, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the worker sees the abort signal so it can stop its own call', async () => {
  const controller = new AbortController();
  let sawAbort = false;
  const done = runMatrix({
    cells: cells(['slow']),
    signal: controller.signal,
    async worker(_cell, ctx) {
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener('abort', () => {
          sawAbort = true;
          resolve();
        });
      });
      return 'ok';
    },
  });
  setTimeout(() => controller.abort(), 20);
  await done;
  assert.ok(sawAbort, 'the worker was handed the signal and saw it fire');
});
