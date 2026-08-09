// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * The template catalog behind `/generate`.
 *
 * The property worth protecting here is that this module never needs Python. Sampling
 * does, and if the catalog did too then a workbench without an interpreter would show an
 * empty page rather than a list of what exists and a note about what is missing. The
 * tests therefore care as much about what is *not* imported as about the values.
 */
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  findRepoRoot,
  humanizeId,
  readStudyConfigs,
  readTemplateCatalog,
  verifierFamilyOf,
} from '../../packages/harness/src/generate/catalog';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

test('the template catalog', async (t) => {
  await t.test('finds every template family in the repository', async () => {
    const templates = await readTemplateCatalog(REPO_ROOT);
    const ids = templates.map((entry) => entry.id);
    assert.deepEqual(ids, [
      'extraction.quarterly_ledger',
      'format.release_note',
      'math.linear_equation',
    ]);
  });

  await t.test('reports the four study locales and their review status', async () => {
    const templates = await readTemplateCatalog(REPO_ROOT);
    for (const template of templates) {
      const byTag = new Map(template.locales.map((l) => [l.tag, l.translationStatus]));
      assert.equal(byTag.get('en'), 'single-reviewer', `${template.id} en`);
      for (const stub of ['hi', 'hi-Latn', 'ko']) {
        assert.equal(byTag.get(stub), 'untranslated', `${template.id} ${stub}`);
      }
    }
  });

  await t.test(
    'a stub reports the same prompt length as English, because it is the same prompt',
    async () => {
      // The page shows these side by side, so a drifted stub would be visible as a
      // different character count before anyone ran a study over it.
      for (const template of await readTemplateCatalog(REPO_ROOT)) {
        const english = template.locales.find((l) => l.tag === 'en');
        assert.ok(english, `${template.id} has no en locale`);
        for (const stub of template.locales.filter((l) => l.translationStatus === 'untranslated')) {
          assert.equal(
            stub.promptCharacters,
            english.promptCharacters,
            `${template.id} ${stub.tag} has drifted from its English source`,
          );
        }
      }
    },
  );

  await t.test('a locale layer with no declared status is treated as unreviewed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'catalog-test-'));
    try {
      const family = join(root, 'templates', 'x', 'y');
      await mkdir(join(family, 'locales'), { recursive: true });
      await mkdir(join(root, 'spec'), { recursive: true });
      await writeFile(
        join(family, 'template.json'),
        JSON.stringify({ id: 'x.y', version: '1.0.0', parameters: [], verifier: { type: 'exact' } }),
      );
      // No translation_status. Absence must not read as approval.
      await writeFile(
        join(family, 'locales', 'en.json'),
        JSON.stringify({ locale: 'en', prompt: 'hi' }),
      );

      const [template] = await readTemplateCatalog(root);
      assert.equal(template.locales[0].translationStatus, 'untranslated');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test('carries a readable title alongside the id', async () => {
    // The id is what the CLI is called with and stays on screen; the title is what the
    // list is scanned by. Both, because either alone loses something.
    const templates = await readTemplateCatalog(REPO_ROOT);
    assert.deepEqual(
      templates.map((entry) => [entry.id, entry.title, entry.familyLabel]),
      [
        ['extraction.quarterly_ledger', 'Quarterly ledger', 'Extraction'],
        ['format.release_note', 'Release note', 'Format'],
        ['math.linear_equation', 'Linear equation', 'Math'],
      ],
    );
  });

  await t.test('names every element when the verifier field holds a list', () => {
    assert.equal(verifierFamilyOf({ type: 'exact' }), 'exact');
    assert.equal(
      verifierFamilyOf([{ type: 'json_schema' }, { type: 'exact' }]),
      '[json_schema, exact]',
    );
  });

  await t.test('a malformed family is skipped rather than blanking the catalog', async () => {
    const root = await mkdtemp(join(tmpdir(), 'catalog-test-'));
    try {
      await mkdir(join(root, 'spec'), { recursive: true });
      const good = join(root, 'templates', 'a', 'good');
      await mkdir(join(good, 'locales'), { recursive: true });
      await writeFile(
        join(good, 'template.json'),
        JSON.stringify({ id: 'a.good', version: '1.0.0', parameters: [], verifier: {} }),
      );
      const bad = join(root, 'templates', 'a', 'bad');
      await mkdir(bad, { recursive: true });
      await writeFile(join(bad, 'template.json'), '{ not json');

      const templates = await readTemplateCatalog(root);
      assert.deepEqual(
        templates.map((entry) => entry.id),
        ['a.good'],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test('the study config catalog', async (t) => {
  await t.test('finds the shipped example and marks it as costing nothing', async () => {
    const configs = await readStudyConfigs(REPO_ROOT);
    const example = configs.find((entry) => entry.id === 'language-cost-mock');
    assert.ok(example, 'the mock study config is not in the catalog');
    assert.equal(example.offline, true);
    assert.deepEqual(example.localeTags, ['en', 'ko', 'hi', 'hi-Latn']);
    assert.equal(example.tokenizer, 'builtin/utf8-bytes 1');
  });

  await t.test('a config naming a harness model is not marked offline', async () => {
    // The route refuses to run a config that is not offline, so this flag is the thing
    // standing between a click and a provider bill.
    const root = await mkdtemp(join(tmpdir(), 'catalog-test-'));
    try {
      await mkdir(join(root, 'spec'), { recursive: true });
      await mkdir(join(root, 'templates'), { recursive: true });
      const examples = join(root, 'packages', 'generate', 'examples');
      await mkdir(examples, { recursive: true });
      await writeFile(
        join(examples, 'paid.study.json'),
        JSON.stringify({
          id: 'paid',
          models: [
            { id: 'mock/a', provider: 'mock' },
            { id: 'openai/gpt-4o-mini', provider: 'harness' },
          ],
        }),
      );

      const [config] = await readStudyConfigs(root);
      assert.equal(config.offline, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test('rendering a machine id for a person', async (t) => {
  await t.test('drops the family, splits the separators, and sentence-cases', () => {
    assert.equal(humanizeId('math.linear_equation'), 'Linear equation');
    assert.equal(humanizeId('extraction.quarterly_ledger'), 'Quarterly ledger');
    assert.equal(humanizeId('language-cost-mock'), 'Language cost mock');
    assert.equal(humanizeId('math'), 'Math');
  });

  await t.test('leaves the rest of the words alone', () => {
    // Sentence case, not title case: only the first word is touched, so an id that
    // already contains a capitalised tag keeps it.
    assert.equal(humanizeId('locale.hi_Latn_stub'), 'Hi Latn stub');
  });

  await t.test('returns the id unchanged when there is nothing to humanize', () => {
    assert.equal(humanizeId(''), '');
    assert.equal(humanizeId('...'), '...');
  });
});

test('finding the repository root', async (t) => {
  await t.test('walks up to the directory holding templates/ and spec/', async () => {
    assert.equal(await findRepoRoot(join(REPO_ROOT, 'packages', 'harness', 'src')), REPO_ROOT);
  });

  await t.test('says so rather than guessing when there is no such directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'catalog-test-'));
    try {
      await assert.rejects(() => findRepoRoot(root), /could not find a directory/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
