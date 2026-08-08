// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * The TypeScript half of the cross-language conformance suite.
 * Run: yarn test
 *
 * These are the same files that `packages/generate/tests/test_conformance.py` reads. Two
 * implementations of one spec are only safe if something forces them to agree on the same
 * inputs, so a divergence here is a CI failure rather than a warning, and neither side is
 * allowed to carry a case list of its own.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalJson,
  DECLARATIVE_VERIFIER_TYPES,
  deriveSeed,
  runVerifier,
  seedMessage,
  seedToString,
  type ConformanceCase,
  type ConformanceFile,
  type Verifier,
} from '../../packages/harness/src/generate/index';

const CONFORMANCE_DIR = path.join(process.cwd(), 'spec', 'conformance');
const MINIMUM_CASES_PER_TYPE = 15;

function load<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(CONFORMANCE_DIR, name), 'utf8')) as T;
}

const verifierFiles = readdirSync(CONFORMANCE_DIR)
  .filter((name) => name.endsWith('.json'))
  .filter((name) =>
    (DECLARATIVE_VERIFIER_TYPES as readonly string[]).includes(name.slice(0, -'.json'.length)),
  )
  .sort();

test('every declarative verifier type has a conformance file', () => {
  const covered = new Set(verifierFiles.map((name) => name.slice(0, -'.json'.length)));
  const missing = DECLARATIVE_VERIFIER_TYPES.filter((type) => !covered.has(type));
  assert.deepEqual(missing, [], `missing conformance files for ${missing.join(', ')}`);
});

const seen = new Set<string>();

for (const filename of verifierFiles) {
  const document = load<ConformanceFile>(filename);
  const verifierType = filename.slice(0, -'.json'.length);

  test(`${filename} is well formed`, () => {
    assert.equal(document.spec_version, 'redrob-verifiable-task/v1');
    assert.equal(document.verifier_type, verifierType);
    assert.ok(
      document.cases.length >= MINIMUM_CASES_PER_TYPE,
      `${filename} has ${document.cases.length} cases, the spec requires at least ${MINIMUM_CASES_PER_TYPE}`,
    );
    const identifiers = document.cases.map((entry) => entry.id);
    assert.equal(new Set(identifiers).size, identifiers.length, `${filename} has duplicate ids`);
    for (const entry of document.cases) {
      assert.equal(
        (entry.verifier as { type: string }).type,
        verifierType,
        `${entry.id} declares the wrong verifier type for ${filename}`,
      );
      assert.equal(seen.has(entry.id), false, `case id ${entry.id} is used twice`);
      seen.add(entry.id);
    }
  });

  for (const entry of document.cases as ConformanceCase[]) {
    test(`${entry.id}`, () => {
      const verdict = runVerifier(entry.verifier as Verifier, entry.candidate);
      assert.deepEqual(
        { passed: verdict.passed, code: verdict.code },
        { passed: entry.expected.passed, code: entry.expected.code },
        `${entry.id}: ${entry.description ?? ''} (${verdict.message ?? 'no message'})`,
      );
    });
  }
}

// ------------------------------------------------------------------- fixtures

interface SeedFixture {
  cases: {
    id: string;
    generator_version: string;
    template_id: string;
    instance_index: number;
    message_utf8_hex: string;
    sha256: string;
    seed: string;
  }[];
}

test('seed fixture: identical seeds across implementations', () => {
  const fixture = load<SeedFixture>('seed-fixture.json');
  assert.ok(fixture.cases.length > 0, 'the seed fixture is empty');
  for (const entry of fixture.cases) {
    const message = seedMessage(entry.generator_version, entry.template_id, entry.instance_index);
    assert.equal(message.toString('hex'), entry.message_utf8_hex, entry.id);
    assert.equal(createHash('sha256').update(message).digest('hex'), entry.sha256, entry.id);
    assert.equal(
      seedToString(deriveSeed(entry.template_id, entry.instance_index, entry.generator_version)),
      entry.seed,
      entry.id,
    );
  }
});

interface CanonicalFixture {
  cases: { id: string; value: unknown; canonical: string; sha256: string }[];
}

test('canonical JSON fixture: identical bytes across implementations', () => {
  const fixture = load<CanonicalFixture>('canonical-json.json');
  assert.ok(fixture.cases.length > 0, 'the canonical JSON fixture is empty');
  for (const entry of fixture.cases) {
    const text = canonicalJson(entry.value);
    assert.equal(text, entry.canonical, entry.id);
    assert.equal(
      createHash('sha256').update(text, 'utf8').digest('hex'),
      entry.sha256,
      entry.id,
    );
  }
});
