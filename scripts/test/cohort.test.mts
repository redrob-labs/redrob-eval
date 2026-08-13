/**
 * Cohorts and annotations.
 *
 * A triage session whose conclusions live in a terminal scrollback did not
 * happen. These pin that a selection survives as something re-runnable, and that
 * a human correction overrides the classifier without erasing what it said.
 * Run: yarn test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  annotateFailure,
  applyAnnotations,
  readAnnotations,
  readCohort,
  saveCohort,
  COHORT_KIND,
} from '../../packages/harness/src/lib/failures/cohort.ts';
import { FsRunStore } from '../../packages/harness/src/lib/registry/fs-store.ts';
import type { RunStore } from '../../packages/harness/src/lib/registry/types.ts';
import type { FailureRecord } from '../../packages/harness/src/lib/failures/types.ts';

async function withStore(fn: (store: RunStore) => Promise<void>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'redrob-cohort-'));
  const store = new FsRunStore(path.join(dir, 'registry'));
  try {
    await fn(store);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const failures: FailureRecord[] = [
  { id: 'm1|t1', kind: 'format', detail: 'no JSON', source: 'tool-routing', model: 'm1', item: 't1', language: 'en' },
  { id: 'm1|t2', kind: 'envelope', detail: 'wrong key', source: 'tool-routing', model: 'm1', item: 't2', language: 'en' },
  { id: 'm2|t1', kind: 'wrong_tool', detail: 'chose x', source: 'tool-routing', model: 'm2', item: 't1', language: 'ko' },
];

test('a cohort is a listable run carrying the filter and what it selected', async () => {
  await withStore(async (store) => {
    const cohort = await saveCohort(store, {
      name: 'wrapper failures',
      sourceRunId: '2026-08-13_000000_tool-routing-matrix',
      filter: { kind: ['format', 'envelope'] },
      failures: failures.slice(0, 2),
    });
    assert.equal(cohort.members.length, 2);
    assert.deepEqual(cohort.members[0], { model: 'm1', item: 't1', kind: 'format', language: 'en' });

    // Listable like any other run, so it shows up in `yarn runs --kind cohort`.
    const listed = await store.list({ kind: COHORT_KIND });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.label, 'wrapper failures');
    assert.equal(listed[0]!.status, 'done', 'a selection is complete the moment it exists');
    assert.deepEqual(listed[0]!.summary, { members: 2 });
    assert.deepEqual(listed[0]!.provenance.models.sort(), ['m1']);

    const read = await readCohort(store, cohort.id);
    assert.equal(read?.name, 'wrapper failures');
    assert.equal(read?.sourceRunId, '2026-08-13_000000_tool-routing-matrix');
    // The filter is kept so the selection is reproducible, and the members so
    // that re-deriving it later cannot silently change the cohort.
    assert.deepEqual(read?.filter, { kind: ['format', 'envelope'] });
    assert.equal(read?.members.length, 2);
  });
});

test('reading a cohort id that is some other kind of run gives nothing', async () => {
  await withStore(async (store) => {
    const notACohort = await store.create({ kind: 'tool-routing', params: {} });
    assert.equal(await readCohort(store, notACohort.id), null);
    assert.equal(await readCohort(store, '2026-01-01_000000_nope'), null);
  });
});

test('a human correction overrides the classifier without erasing it', async () => {
  await withStore(async (store) => {
    const run = await store.create({ kind: 'tool-routing-matrix', params: {} });
    assert.deepEqual(await readAnnotations(store, run.id), {});

    await annotateFailure(store, run.id, {
      failureId: 'm1|t1',
      kind: 'bad_arguments',
      note: 'it did emit JSON; the fence confused the parser',
    });
    const annotations = await readAnnotations(store, run.id);
    assert.equal(annotations['m1|t1']!.kind, 'bad_arguments');
    assert.ok(annotations['m1|t1']!.at, 'an annotation is stamped');

    const folded = applyAnnotations(failures, annotations);
    const corrected = folded.find((f) => f.id === 'm1|t1')!;
    assert.equal(corrected.kind, 'bad_arguments', "the human's verdict wins");
    // Keeping the derived kind is what makes a systematically wrong classifier
    // visible rather than quietly overwritten.
    assert.equal(corrected.derivedKind, 'format');
    assert.equal(corrected.annotated, true);
    assert.match(corrected.note!, /fence confused the parser/);

    // Untouched failures are unchanged and unmarked.
    const other = folded.find((f) => f.id === 'm2|t1')!;
    assert.equal(other.kind, 'wrong_tool');
    assert.equal(other.annotated, undefined);
  });
});

test('a note without a new kind annotates but does not reclassify', async () => {
  await withStore(async (store) => {
    const run = await store.create({ kind: 'tool-routing-matrix', params: {} });
    await annotateFailure(store, run.id, { failureId: 'm1|t2', note: 'known upstream bug' });
    const folded = applyAnnotations(failures, await readAnnotations(store, run.id));
    const target = folded.find((f) => f.id === 'm1|t2')!;
    assert.equal(target.kind, 'envelope', 'the classification stands');
    assert.equal(target.derivedKind, undefined, 'nothing was overridden');
    assert.equal(target.annotated, true);
  });
});

test('annotating twice keeps the latest verdict', async () => {
  await withStore(async (store) => {
    const run = await store.create({ kind: 'tool-routing-matrix', params: {} });
    await annotateFailure(store, run.id, { failureId: 'm1|t1', kind: 'bad_arguments' });
    await annotateFailure(store, run.id, { failureId: 'm1|t1', kind: 'wrong_tool', note: 'on reflection' });
    const annotations = await readAnnotations(store, run.id);
    assert.equal(Object.keys(annotations).length, 1);
    assert.equal(annotations['m1|t1']!.kind, 'wrong_tool');
    assert.equal(annotations['m1|t1']!.note, 'on reflection');
  });
});
