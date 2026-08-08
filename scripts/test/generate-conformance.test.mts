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

import { Ajv2020 } from 'ajv/dist/2020.js';

import {
  canonicalJson,
  DECLARATIVE_VERIFIER_TYPES,
  deriveSeed,
  runVerifier,
  runVerifierOrFail,
  seedMessage,
  seedToString,
  UnsupportedVerifierError,
  VerifierConfigError,
  type ConformanceCase,
  type ConformanceFile,
  type ConformanceRejection,
  type ConformanceSchemaRejection,
  type Verifier,
} from '../../packages/harness/src/generate/index';

const CONFORMANCE_DIR = path.join(process.cwd(), 'spec', 'conformance');
const MINIMUM_CASES_PER_TYPE = 15;

/** Names a conformance file may carry: one per declarative verifier, plus the list-valued
 *  verifier field, which is a shape of the field rather than a verifier type and so has
 *  no entry in the registry. */
const CORPUS_NAMES = new Set<string>([...DECLARATIVE_VERIFIER_TYPES, 'verifier_list']);

function load<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(CONFORMANCE_DIR, name), 'utf8')) as T;
}

const verifierFiles = readdirSync(CONFORMANCE_DIR)
  .filter((name) => name.endsWith('.json'))
  .filter((name) => CORPUS_NAMES.has(name.slice(0, -'.json'.length)))
  .sort();

test('every declarative verifier type has a conformance file', () => {
  const covered = new Set(verifierFiles.map((name) => name.slice(0, -'.json'.length)));
  const missing = [...CORPUS_NAMES].filter((type) => !covered.has(type));
  assert.deepEqual(missing, [], `missing conformance files for ${missing.join(', ')}`);
});

const seen = new Set<string>();

for (const filename of verifierFiles) {
  const document = load<ConformanceFile>(filename);
  const verifierType = filename.slice(0, -'.json'.length);

  test(`${filename} is well formed`, () => {
    assert.equal(document.spec_version, 'redrob-verifiable-task/v2');
    assert.equal(document.verifier_type, verifierType);
    assert.ok(
      document.cases.length >= MINIMUM_CASES_PER_TYPE,
      `${filename} has ${document.cases.length} cases, the spec requires at least ${MINIMUM_CASES_PER_TYPE}`,
    );
    const rows = [
      ...document.cases,
      ...(document.rejections ?? []),
      ...(document.schema_rejections ?? []),
    ];
    const identifiers = rows.map((entry) => entry.id);
    assert.equal(new Set(identifiers).size, identifiers.length, `${filename} has duplicate ids`);
    for (const entry of rows) {
      assert.equal(seen.has(entry.id), false, `case id ${entry.id} is used twice`);
      seen.add(entry.id);
    }

    if (verifierType === 'verifier_list') {
      // This file tests a shape of the verifier field rather than a verifier type, so its
      // rows carry whatever types the shape is being exercised with. What it must contain
      // is both shapes: a corpus of only lists would leave the single form unchecked.
      const shapes = new Set(document.cases.map((entry) => Array.isArray(entry.verifier)));
      assert.deepEqual(
        [...shapes].sort(),
        [false, true],
        `${filename} does not cover both shapes of the field`,
      );
      return;
    }
    for (const entry of [...document.cases, ...(document.rejections ?? [])]) {
      assert.equal(
        Array.isArray(entry.verifier),
        false,
        `${entry.id} is a verifier list, which belongs in verifier_list.json`,
      );
      const declared = (entry.verifier as { type?: string }).type;
      assert.ok(
        declared === verifierType || declared === undefined,
        `${entry.id} declares a ${declared} verifier in ${filename}`,
      );
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

      // The per-element report is normative for a list, and the rest of `detail` is not.
      // Comparing it is what makes the report evidence: an implementation that reaches the
      // right overall verdict by running the wrong elements, or by stopping early, agrees
      // on `code` and disagrees here.
      if (Array.isArray(entry.verifier)) {
        assert.ok(entry.expected.elements, `${entry.id} is a list and declares no element report`);
        assert.deepEqual(verdict.detail?.elements, entry.expected.elements, entry.id);
      } else {
        assert.equal(entry.expected.elements, undefined, `${entry.id} is not a list`);
        assert.equal(
          verdict.detail?.elements,
          undefined,
          `${entry.id}: a single verifier must not report elements`,
        );
      }
    });
  }

  // Rows asserting that a configuration is refused rather than evaluated. Both halves
  // matter: the raise is the contract for a caller that wants to know its verifier is
  // unusable, and the verdict is what a caller scoring a whole set gets instead of an
  // aborted run. Neither is allowed to be a pass.
  for (const entry of (document.rejections ?? []) as ConformanceRejection[]) {
    test(`${entry.id}`, () => {
      const expectedError =
        entry.raises === 'unsupported_verifier' ? UnsupportedVerifierError : VerifierConfigError;
      assert.throws(
        () => runVerifier(entry.verifier as Verifier, entry.candidate),
        expectedError,
        `${entry.id}: ${entry.description ?? ''}`,
      );

      if (entry.raises === 'unsupported_verifier') {
        const verdict = runVerifierOrFail(entry.verifier as Verifier, entry.candidate);
        assert.equal(verdict.passed, false, `${entry.id} must never report a pass`);
        assert.equal(verdict.code, entry.expected.code, entry.id);
      }
    });
  }

  // Rows asserting that a document is refused by schema validation, before any verifier
  // runs. A runtime refusal and a structural one are different guarantees: the first
  // holds for callers that reach this dispatcher, the second for anything that validates
  // the document. Both halves of each row are checked, because a rejection test passes
  // trivially if the schema rejects everything.
  for (const entry of (document.schema_rejections ?? []) as ConformanceSchemaRejection[]) {
    test(`${entry.id}`, () => {
      const validate = specValidator(entry.definition);
      assert.equal(
        validate(entry.document),
        false,
        `${entry.id}: the schema accepted a document it must refuse`,
      );
      assert.equal(
        validate(entry.valid_counterpart),
        true,
        `${entry.id}: the schema refused the valid counterpart, so the row above proves ` +
          `nothing (${JSON.stringify(validate.errors?.[0])})`,
      );
    });
  }
}

// The spec schema is draft 2020-12, and this is the one place the suite needs a general
// validator rather than the subset one the json_schema verifier uses. It is a dev
// dependency; `generate-json-schema-oracle.test.mts` asserts that nothing shipped imports
// it.
const ajv = new Ajv2020({ strict: false, allErrors: false });
const specSchema = JSON.parse(
  readFileSync(path.join(process.cwd(), 'spec', 'verifiable-task-v2.schema.json'), 'utf8'),
) as { $defs: Record<string, unknown> };

function specValidator(definition: string) {
  assert.ok(definition in specSchema.$defs, `unknown schema definition ${definition}`);
  return ajv.compile({ $ref: `#/$defs/${definition}`, $defs: specSchema.$defs });
}

test('the rejection rows assert a refusal, not merely a failing verdict', () => {
  let count = 0;
  for (const filename of verifierFiles) {
    const document = load<ConformanceFile>(filename);
    for (const entry of (document.rejections ?? []) as ConformanceRejection[]) {
      assert.equal(entry.expected.passed, false, entry.id);
      assert.equal(entry.expected.code, 'unsupported_verifier', entry.id);
      count += 1;
    }
  }
  assert.ok(count > 0, 'the rejection suite is empty, so it proves nothing');
});

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
