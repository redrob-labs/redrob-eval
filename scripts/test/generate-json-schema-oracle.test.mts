// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * Differential test of the JSON Schema subset against a mature library.
 *
 * The TypeScript validator is hand-written, and the conformance suite only proves that it
 * agrees with the Python one. Two implementations can agree with each other while both
 * misread the specification, and parity testing cannot see that: the suite would be green
 * and the subset would be quietly wrong. So a third opinion is needed, from something
 * neither implementation was derived from.
 *
 * `ajv` is that opinion here, and it is a dev dependency only. Nothing in the shipped
 * module imports it, which is the point: the subset must be small enough to implement
 * without a library, and this test is how that claim stays honest.
 *
 * The corpus expectation is the pivot that makes this a three-way check. The Python
 * conformance suite already proves `jsonschema` matches the expectation, and the
 * TypeScript conformance suite proves this validator does. Proving `ajv` matches it too
 * means all four agree, and the two independent libraries are what rule out a shared
 * misreading.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { Ajv2020 } from 'ajv/dist/2020.js';

import {
  runVerifier,
  type ConformanceFile,
  type Verifier,
} from '../../packages/harness/src/generate/index';

const directory = path.join(process.cwd(), 'spec', 'conformance');

/**
 * Cases where a disagreement with `ajv` is intentional and correct.
 *
 * Empty, and it should stay that way. An entry here is a claim that a hand-written
 * validator reads the specification better than a library with a decade of use, so each
 * one needs the reasoning written out, not just an id.
 */
const DOCUMENTED_DISAGREEMENTS = new Map<string, string>();

interface Row {
  id: string;
  schema: unknown;
  candidate: string;
  expected: { passed: boolean; code: string };
}

/** Every json_schema verifier in the corpus, including those nested inside an all_of. */
function collectRows(): Row[] {
  const rows: Row[] = [];

  const walk = (verifier: unknown, id: string, candidate: string, expected: Row['expected']) => {
    if (!verifier || typeof verifier !== 'object') return;
    const node = verifier as { type?: string; schema?: unknown; verifiers?: unknown[] };
    if (node.type === 'json_schema') {
      rows.push({ id: `${id}#${rows.length}`, schema: node.schema, candidate, expected });
      return;
    }
    if (node.type === 'all_of' && Array.isArray(node.verifiers)) {
      for (const child of node.verifiers) walk(child, id, candidate, expected);
    }
  };

  for (const filename of ['json_schema.json', 'all_of.json']) {
    const document = JSON.parse(
      fs.readFileSync(path.join(directory, filename), 'utf8'),
    ) as ConformanceFile;
    for (const entry of document.cases) {
      walk(entry.verifier, entry.id, entry.candidate, entry.expected);
    }
  }
  return rows;
}

const rows = collectRows();

// strict mode off because it rejects schemas that draft 2020-12 permits, such as a
// `contains` with no `type` alongside it. The subset is about what implementations must
// support, not about ajv's opinion on schema style.
const ajv = new Ajv2020({ strict: false, allErrors: false });

function ajvAccepts(schema: unknown, value: unknown): boolean {
  return ajv.compile(schema as object)(value) === true;
}

test('the oracle corpus is not empty', () => {
  assert.ok(rows.length >= 40, `only ${rows.length} json_schema rows found`);
});

test('ajv is a dev dependency and no shipped module imports it', () => {
  // The subset exists so that an implementation needs no library. If ajv ever appears in
  // a dependencies block or in shipped source, that claim is false and this test is the
  // only thing that would notice.
  const manifests = [
    'package.json',
    'packages/harness/package.json',
    'packages/tokenizers/package.json',
  ];
  for (const manifest of manifests) {
    const full = path.join(process.cwd(), manifest);
    if (!fs.existsSync(full)) continue;
    const parsed = JSON.parse(fs.readFileSync(full, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    assert.equal(
      parsed.dependencies?.ajv,
      undefined,
      `${manifest} lists ajv as a runtime dependency`,
    );
  }

  const shipped = path.join(process.cwd(), 'packages', 'harness', 'src', 'generate');
  for (const entry of fs.readdirSync(shipped)) {
    if (!entry.endsWith('.ts')) continue;
    const source = fs.readFileSync(path.join(shipped, entry), 'utf8');
    assert.ok(!/from\s+'ajv|require\('ajv/.test(source), `${entry} imports ajv`);
  }
});

for (const row of rows) {
  test(`ajv agrees with the subset validator: ${row.id}`, () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.candidate);
    } catch {
      // A candidate that is not JSON never reaches schema evaluation, so there is nothing
      // for an oracle to have an opinion about.
      return;
    }

    const verdict = runVerifier({ type: 'json_schema', schema: row.schema } as Verifier, row.candidate);
    const mine = verdict.passed;
    const theirs = ajvAccepts(row.schema, parsed);

    if (mine !== theirs) {
      const reason = DOCUMENTED_DISAGREEMENTS.get(row.id);
      assert.ok(
        reason,
        `${row.id}: this validator says ${mine} and ajv says ${theirs}. Two implementations ` +
          'agreeing with each other while both disagree with a mature library means the ' +
          'subset is subtly wrong. Fix it, or add an entry to DOCUMENTED_DISAGREEMENTS ' +
          'with the reasoning.',
      );
      return;
    }
    assert.equal(mine, theirs);
  });
}

for (const row of rows) {
  test(`ajv agrees with the recorded expectation: ${row.id}`, () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.candidate);
    } catch {
      return;
    }
    // Only meaningful where the whole case turns on this schema. A row nested in an
    // all_of may be preceded by a sibling that fails first, so the case-level expectation
    // is not this schema's verdict.
    if (!row.id.startsWith('json_schema/')) return;
    assert.equal(
      ajvAccepts(row.schema, parsed),
      row.expected.passed,
      `${row.id}: ajv disagrees with the expectation the Python suite validated against ` +
        'jsonschema, so the two libraries disagree and the case needs a human',
    );
  });
}
