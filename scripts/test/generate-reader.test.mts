// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * Reading and auditing a real generated set.
 * Run: yarn test
 *
 * The fixture in `spec/conformance/example-set/` was written by the Python emitter, so
 * these assertions are a cross-language check rather than a round trip: TypeScript
 * recomputes the seeds and the template content hash from the published inputs and
 * compares them against what Python wrote. If the two ever disagree about canonical JSON
 * or about the seed formula, this is where it surfaces.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  auditManifestConsistency,
  auditSeeds,
  auditTemplateHash,
  contentHash,
  GeneratedSetError,
  mergeTemplateLayers,
  parseInstances,
  readGeneratedSet,
  readTemplate,
  runVerifier,
  SEED_METHOD,
  type Instance,
  type Verifier,
} from '../../packages/harness/src/generate/index';

const root = process.cwd();
const setDirectory = path.join(root, 'spec', 'conformance', 'example-set');
const templateDirectory = path.join(root, 'templates', 'math', 'linear-equation');

test('reads the example set and its manifest', async () => {
  const set = await readGeneratedSet(setDirectory);
  assert.equal(set.manifest.spec_version, 'redrob-verifiable-task/v1');
  assert.equal(set.manifest.locale, 'en');
  assert.equal(set.manifest.seed_derivation.method, SEED_METHOD);
  assert.equal(set.instances.length, set.manifest.instance_count);
  assert.ok(set.manifest.citation.bibtex.includes('@software'), 'the manifest carries BibTeX');
});

test('every seed in the example set recomputes', async () => {
  const set = await readGeneratedSet(setDirectory);
  const audit = auditSeeds(set);
  assert.equal(audit.entries.length, set.instances.length);
  assert.deepEqual(audit.mismatches, [], 'a seed the reader cannot recompute makes the set unauditable');
  assert.equal(audit.ok, true);
});

test('a tampered seed is caught', async () => {
  const set = await readGeneratedSet(setDirectory);
  const tampered = {
    ...set,
    instances: set.instances.map((instance, index) =>
      index === 0 ? ({ ...instance, seed: '42' } as Instance) : instance,
    ),
  };
  const audit = auditSeeds(tampered);
  assert.equal(audit.ok, false);
  assert.equal(audit.mismatches.length, 1);
  assert.equal(audit.mismatches[0]?.claimed, '42');
});

test('the template content hash agrees with Python', async () => {
  const set = await readGeneratedSet(setDirectory);
  const template = await readTemplate(templateDirectory, 'en');
  const entry = set.manifest.templates.find((candidate) => candidate.id === template.id);
  assert.ok(entry, 'the manifest lists the template the set was generated from');
  const audit = auditTemplateHash(template, entry.content_hash);
  assert.equal(
    audit.matches,
    true,
    `canonical JSON diverged: TypeScript computed ${audit.recomputed}, Python wrote ${audit.claimed}`,
  );
  assert.match(audit.recomputed, /^sha256:[0-9a-f]{64}$/);
});

test('the instances agree with the manifest about their template', async () => {
  const set = await readGeneratedSet(setDirectory);
  assert.deepEqual(auditManifestConsistency(set), []);
});

test('a locale layer may not redeclare the task', () => {
  const core = { id: 'x', version: '1.0.0', parameters: [] };
  assert.deepEqual(mergeTemplateLayers(core, { locale: 'en', prompt: 'hello' }).prompt, 'hello');
  assert.throws(
    () => mergeTemplateLayers(core, { locale: 'xx', parameters: [] }),
    GeneratedSetError,
  );
});

test('a malformed instance line is an error, not a skipped row', () => {
  assert.throws(() => parseInstances('{"a":1}\nnot json\n'), GeneratedSetError);
  assert.equal(parseInstances('\n\n').length, 0);
});

test('the expected answer in each instance satisfies its own verifier', async () => {
  const set = await readGeneratedSet(setDirectory);
  for (const instance of set.instances) {
    const answer = (instance.derived as Record<string, unknown>).answer as number;
    const verdict = runVerifier(instance.verifier as Verifier, answer.toFixed(4));
    assert.equal(
      verdict.passed,
      true,
      `instance ${instance.instance_index} rejects its own answer: ${verdict.message}`,
    );
    assert.equal(runVerifier(instance.verifier as Verifier, 'not a number').passed, false);
  }
});

test('contentHash is stable and prefixed', () => {
  const template = JSON.parse(
    readFileSync(path.join(templateDirectory, 'template.json'), 'utf8'),
  ) as Record<string, unknown>;
  assert.equal(contentHash(template), contentHash({ ...template }));
  assert.notEqual(contentHash(template), contentHash({ ...template, version: '9.9.9' }));
});
