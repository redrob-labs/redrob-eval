// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * Dump the verdict this implementation produces for every conformance case.
 * Run: tsx scripts/generate-verdicts.mts > /tmp/ts.json
 *
 * Its counterpart is `scripts/generate_verdicts.py`. Each conformance suite already checks
 * its own side against the expected verdict in the case file, which is enough to catch a
 * divergence; diffing these two dumps is what *shows* it, as a list of case ids rather
 * than as two separate red builds that a reader has to correlate by hand.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  DECLARATIVE_VERIFIER_TYPES,
  runVerifierOrFail,
  scanRegexPattern,
  VerifierConfigError,
  type ConformanceFile,
  type Verifier,
} from '../packages/harness/src/generate/index';

const directory = path.join(process.cwd(), 'spec', 'conformance');
const verdicts: Record<string, [boolean | 'raises', string]> = {};

/**
 * The token stream a pattern scans to, alongside the verdict it produces.
 *
 * The two scanners walk a pattern with an index, and the thing being indexed is not the
 * same on the two sides: a Python string steps by code point and a JavaScript string steps
 * by UTF-16 code unit, so an astral character is one step on one side and two on the other.
 * The JavaScript scanner reassembles surrogate pairs to compensate. Comparing verdicts
 * alone would not notice if it stopped: a pattern can tokenise differently and still match
 * or fail to match the same candidate. Comparing the token stream does.
 */
function tokenSignature(pattern: string): string {
  try {
    return scanRegexPattern(pattern)
      .map((token) => `${token.kind}:${token.text}`)
      .join(' ');
  } catch (error) {
    return `error:${(error as Error).name}`;
  }
}

for (const filename of readdirSync(directory).sort()) {
  if (!filename.endsWith('.json')) continue;
  if (!(DECLARATIVE_VERIFIER_TYPES as readonly string[]).includes(filename.slice(0, -5))) continue;
  const document = JSON.parse(
    readFileSync(path.join(directory, filename), 'utf8'),
  ) as ConformanceFile;
  // Rejection rows are dumped too, so a configuration that must be refused is compared
  // across implementations rather than only within each one. A malformed configuration
  // raises rather than producing a verdict, and the raise is recorded as such: turning it
  // into a verdict here would hide the difference the comparison is looking for.
  for (const entry of [...document.cases, ...(document.rejections ?? [])]) {
    try {
      const verdict = runVerifierOrFail(entry.verifier as Verifier, entry.candidate);
      verdicts[entry.id] = [verdict.passed, verdict.code];
    } catch (error) {
      if (!(error instanceof VerifierConfigError)) throw error;
      verdicts[entry.id] = ['raises', 'verifier_config'];
    }
    const pattern = (entry.verifier as { type?: string; pattern?: unknown }).pattern;
    if (
      (entry.verifier as { type?: string }).type === 'regex' &&
      typeof pattern === 'string'
    ) {
      verdicts[`tokens:${entry.id}`] = ['raises', tokenSignature(pattern)];
    }
  }
}

const ordered = Object.keys(verdicts)
  .sort()
  .map((id) => `  ${JSON.stringify(id)}: ${JSON.stringify(verdicts[id])}`);
process.stdout.write(`{\n${ordered.join(',\n')}\n}\n`);
