// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * Verification must not touch the network.
 * Run: yarn test
 *
 * Determinism is the whole claim of this module: a third party who has the generator
 * version and the template id must be able to recompute the same items and the same
 * verdicts, on a laptop with the wifi off, years later. A single lookup of a remote schema
 * or a remote tokenizer would quietly break that, so every socket entry point is replaced
 * with a tripwire before the suite runs and any use of one fails the test.
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  auditSeeds,
  canonicalJson,
  contentHash,
  DECLARATIVE_VERIFIER_TYPES,
  readGeneratedSet,
  readTemplate,
  runVerifierOrFail,
  type ConformanceFile,
  type Verifier,
} from '../../packages/harness/src/generate/index';

const attempts: string[] = [];

function tripwire(name: string) {
  return (...args: unknown[]) => {
    attempts.push(`${name}(${args.map((value) => String(value)).join(', ')})`);
    throw new Error(`network access attempted via ${name}`);
  };
}

// Replaced for the whole file. These tests never restore the originals, because nothing
// in this file legitimately needs a socket.
(globalThis as { fetch?: unknown }).fetch = tripwire('fetch');
net.connect = tripwire('net.connect') as unknown as typeof net.connect;
net.createConnection = tripwire('net.createConnection') as unknown as typeof net.createConnection;
net.Socket.prototype.connect = tripwire('net.Socket#connect') as never;
tls.connect = tripwire('tls.connect') as unknown as typeof tls.connect;
dns.lookup = tripwire('dns.lookup') as unknown as typeof dns.lookup;
dns.promises.lookup = tripwire('dns.promises.lookup') as unknown as typeof dns.promises.lookup;
http.request = tripwire('http.request') as unknown as typeof http.request;
https.request = tripwire('https.request') as unknown as typeof https.request;

const CONFORMANCE_DIR = path.join(process.cwd(), 'spec', 'conformance');

test('the tripwire itself works', () => {
  assert.throws(() => net.connect(80, 'example.com'), /network access attempted/);
  assert.equal(attempts.length, 1);
  attempts.length = 0;
});

test('running every conformance case opens no socket', () => {
  let executed = 0;
  for (const filename of readdirSync(CONFORMANCE_DIR)) {
    if (!filename.endsWith('.json')) continue;
    if (!(DECLARATIVE_VERIFIER_TYPES as readonly string[]).includes(filename.slice(0, -5))) {
      continue;
    }
    const document = JSON.parse(
      readFileSync(path.join(CONFORMANCE_DIR, filename), 'utf8'),
    ) as ConformanceFile;
    for (const entry of document.cases) {
      runVerifierOrFail(entry.verifier as Verifier, entry.candidate);
      executed += 1;
    }
  }
  assert.ok(executed > 0, 'the conformance suite is empty, so this proves nothing');
  assert.deepEqual(attempts, [], `verification reached the network: ${attempts.join('; ')}`);
});

test('reading, hashing and auditing a generated set opens no socket', async () => {
  const set = await readGeneratedSet(path.join(CONFORMANCE_DIR, 'example-set'));
  const template = await readTemplate(path.join(process.cwd(), 'templates', 'math', 'linear-equation'));
  contentHash(template);
  canonicalJson(set.manifest);
  assert.equal(auditSeeds(set).ok, true);
  assert.deepEqual(attempts, [], `auditing reached the network: ${attempts.join('; ')}`);
});

test('a json_schema verifier refuses a remote $ref rather than fetching it', () => {
  assert.throws(
    () =>
      runVerifierOrFail(
        {
          type: 'json_schema',
          schema: { $ref: 'https://example.com/schema.json' },
        } as unknown as Verifier,
        '{"a":1}',
      ),
    /only local '#\/\$defs\/\.\.\.' references are supported/,
  );
  assert.deepEqual(attempts, [], 'the reference must be refused at configuration time');
});
