/**
 * The experiment registry, exercised against every driver.
 *
 * The suite is written once and run against each store, because the promise the
 * registry makes is that the driver is a configuration detail. A behaviour that
 * only holds on one of them is the bug this file exists to catch.
 * Run: yarn test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { FsRunStore } from '../../packages/harness/src/lib/registry/fs-store.ts';
import { SqliteRunStore } from '../../packages/harness/src/lib/registry/sqlite-store.ts';
import {
  defaultRegistryPath,
  registryConfigFromEnv,
} from '../../packages/harness/src/lib/registry/index.ts';
import {
  assertSafeRunId,
  hashParams,
  makeRunId,
} from '../../packages/harness/src/lib/registry/provenance.ts';
import type {
  NewRun,
  RunStore,
} from '../../packages/harness/src/lib/registry/types.ts';

/** Pinned provenance: a test must not depend on the checkout it runs in. */
const PINNED: NewRun['provenance'] = {
  gitSha: 'abc123',
  gitDirty: false,
  runtime: { node: 'v22.0.0', platform: 'linux' },
};

function seed(over: Partial<NewRun> = {}): NewRun {
  return {
    kind: 'tool-routing',
    params: { models: ['a'], languages: ['en'] },
    models: ['a'],
    provenance: PINNED,
    ...over,
  };
}

const drivers: Array<{ name: string; open: (dir: string) => Promise<RunStore> }> = [
  { name: 'fs', open: async (dir) => new FsRunStore(path.join(dir, 'registry')) },
  { name: 'sqlite', open: (dir) => SqliteRunStore.open(path.join(dir, 'registry.sqlite')) },
];

for (const driver of drivers) {
  const withStore = async (fn: (store: RunStore) => Promise<void>) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'redrob-registry-'));
    const store = await driver.open(dir);
    try {
      await fn(store);
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test(`[${driver.name}] a new run is readable back with its provenance`, async () => {
    await withStore(async (store) => {
      const run = await store.create(seed({ label: 'first' }));
      assert.equal(run.kind, 'tool-routing');
      assert.equal(run.status, 'running');
      assert.equal(run.label, 'first');
      assert.ok(run.startedAt, 'a running run has started');
      assert.equal(run.provenance.gitSha, 'abc123');
      assert.deepEqual(run.provenance.models, ['a']);
      assert.ok(run.provenance.paramsHash, 'params are hashed for comparison');

      const read = await store.get(run.id);
      assert.deepEqual(read, run, 'what comes back is what went in');
      assert.equal(await store.get('2026-01-01_000000_nope'), null);
    });
  });

  test(`[${driver.name}] a queued run has not started until it does`, async () => {
    await withStore(async (store) => {
      const run = await store.create(seed({ status: 'queued' }));
      assert.equal(run.status, 'queued');
      assert.equal(run.startedAt, undefined);

      const started = await store.update(run.id, { status: 'running' });
      assert.ok(started.startedAt, 'starting stamps the time without being asked');
      assert.equal(started.finishedAt, undefined);

      const done = await store.update(run.id, { status: 'done', summary: { n: 81 } });
      assert.ok(done.finishedAt, 'finishing stamps the time too');
      assert.deepEqual(done.summary, { n: 81 });
    });
  });

  test(`[${driver.name}] a failure keeps the reason`, async () => {
    await withStore(async (store) => {
      const run = await store.create(seed());
      const failed = await store.update(run.id, { status: 'failed', error: 'HTTP 503' });
      assert.equal(failed.status, 'failed');
      assert.equal(failed.error, 'HTTP 503');
      assert.ok(failed.finishedAt);
      await assert.rejects(
        () => store.update('2026-01-01_000000_nope', { status: 'done' }),
        /Unknown run/,
      );
    });
  });

  test(`[${driver.name}] runs come back newest first, and page`, async () => {
    await withStore(async (store) => {
      const a = await store.create(seed({ label: 'a' }));
      const b = await store.create(seed({ label: 'b' }));
      const c = await store.create(seed({ label: 'c' }));
      // Ids carry a timestamp to the second, so order is pinned explicitly.
      const all = await store.list();
      assert.equal(all.length, 3);
      assert.deepEqual(
        new Set(all.map((r) => r.id)),
        new Set([a.id, b.id, c.id]),
      );
      const page = await store.list({ limit: 2 });
      assert.equal(page.length, 2);
      const rest = await store.list({ limit: 2, offset: 2 });
      assert.equal(rest.length, 1);
      // Paging must not change how many there are.
      assert.equal(await store.count({ limit: 2 }), 3);
    });
  });

  test(`[${driver.name}] filters narrow by kind, status, tag, model and text`, async () => {
    await withStore(async (store) => {
      const tool = await store.create(seed({ tags: ['paper', 'sub10b'], label: 'granite sweep' }));
      const evalRun = await store.create(
        seed({ kind: 'eval', models: ['b'], tags: ['paper'], label: 'gsm8k' }),
      );
      await store.update(evalRun.id, { status: 'done' });

      assert.deepEqual((await store.list({ kind: 'eval' })).map((r) => r.id), [evalRun.id]);
      assert.equal((await store.list({ kind: ['eval', 'tool-routing'] })).length, 2);
      assert.deepEqual((await store.list({ status: 'done' })).map((r) => r.id), [evalRun.id]);
      assert.deepEqual((await store.list({ model: 'b' })).map((r) => r.id), [evalRun.id]);
      // Every tag has to match, not any of them.
      assert.deepEqual((await store.list({ tags: ['paper'] })).length, 2);
      assert.deepEqual(
        (await store.list({ tags: ['paper', 'sub10b'] })).map((r) => r.id),
        [tool.id],
      );
      assert.deepEqual((await store.list({ search: 'GRANITE' })).map((r) => r.id), [tool.id]);
      assert.equal((await store.list({ search: 'nothing' })).length, 0);
    });
  });

  test(`[${driver.name}] the same question is findable by its params hash`, async () => {
    await withStore(async (store) => {
      const first = await store.create(seed());
      // Same params, written in a different key order.
      const second = await store.create(
        seed({ params: { languages: ['en'], models: ['a'] } }),
      );
      const different = await store.create(seed({ params: { models: ['a'], languages: ['ko'] } }));

      assert.equal(
        first.provenance.paramsHash,
        second.provenance.paramsHash,
        'key order is not part of the question',
      );
      assert.notEqual(first.provenance.paramsHash, different.provenance.paramsHash);
      const same = await store.list({ paramsHash: first.provenance.paramsHash });
      assert.deepEqual(new Set(same.map((r) => r.id)), new Set([first.id, second.id]));
    });
  });

  test(`[${driver.name}] events keep their order and their payload`, async () => {
    await withStore(async (store) => {
      const run = await store.create(seed());
      assert.deepEqual(await store.readEvents(run.id), []);
      await store.appendEvents(run.id, [
        { level: 'info', message: 'started', data: { total: 81 } },
        { level: 'warn', message: 'rate limited' },
      ]);
      await store.appendEvents(run.id, [{ level: 'error', message: 'gave up' }]);
      // Appending nothing is not an error, so callers need no guard.
      await store.appendEvents(run.id, []);

      const events = await store.readEvents(run.id);
      assert.deepEqual(events.map((e) => e.seq), [1, 2, 3]);
      assert.deepEqual(events.map((e) => e.message), ['started', 'rate limited', 'gave up']);
      assert.deepEqual(events[0]!.data, { total: 81 });
      assert.equal(events[1]!.data, undefined);
      assert.ok(events[0]!.at, 'every event is stamped');
    });
  });

  test(`[${driver.name}] the module payload is stored, never interpreted`, async () => {
    await withStore(async (store) => {
      // Deliberately a shape the registry knows nothing about.
      const params = { brackets: [{ promptId: 'p1', rounds: [[{ a: 'x' }]] }], nested: { deep: [1, 2] } };
      const run = await store.create(seed({ kind: 'tournament', params }));
      const read = await store.get(run.id);
      assert.deepEqual(read?.params, params, 'an unknown shape survives the round trip');
    });
  });
}

test('a run id is sortable, readable, and validated before it is a path', () => {
  const id = makeRunId('tool-routing', new Date('2026-08-13T01:42:10Z'));
  assert.match(id, /^\d{4}-\d{2}-\d{2}_\d{6}_tool-routing$/);
  assert.equal(assertSafeRunId(id), id);
  // The filesystem driver turns an id into a directory name.
  assert.throws(() => assertSafeRunId('../../etc/passwd'), /Invalid run id/);
  assert.throws(() => assertSafeRunId(''), /Invalid run id/);
  assert.match(makeRunId('Weird Kind!!'), /_weird-kind-$/);
});

test('the params hash ignores key order but not values', () => {
  assert.equal(hashParams({ a: 1, b: [2, 3] }), hashParams({ b: [2, 3], a: 1 }));
  assert.notEqual(hashParams({ a: 1 }), hashParams({ a: 2 }));
  // Order inside an array is part of the question.
  assert.notEqual(hashParams({ a: [1, 2] }), hashParams({ a: [2, 1] }));
});

test('the driver is configuration, and a bad one is refused loudly', () => {
  assert.deepEqual(registryConfigFromEnv({}), { driver: 'fs' });
  assert.deepEqual(registryConfigFromEnv({ REDROB_REGISTRY_DRIVER: 'sqlite' }), {
    driver: 'sqlite',
  });
  assert.deepEqual(
    registryConfigFromEnv({ REDROB_REGISTRY_DRIVER: 'fs', REDROB_REGISTRY_PATH: '/tmp/x' }),
    { driver: 'fs', path: '/tmp/x' },
  );
  assert.throws(
    () => registryConfigFromEnv({ REDROB_REGISTRY_DRIVER: 'postgres' }),
    /must be fs or sqlite/,
  );
  assert.match(defaultRegistryPath('fs'), /eval[/\\]registry$/);
  assert.match(defaultRegistryPath('sqlite'), /eval[/\\]registry\.sqlite$/);
});
