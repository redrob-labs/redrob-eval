// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * Dump this runtime's Unicode tables for the operations the verifiers depend on.
 *
 * Run: `npx tsx scripts/unicode-tables.mts > /tmp/js-unicode.txt`
 *
 * The declarative verifiers lean on two things this repository does not implement and
 * cannot test by comparing itself to itself: `String.prototype.normalize` and
 * `String.prototype.toLowerCase`. Their Python counterparts are separate implementations
 * over a separately versioned character database, so "both sides normalise" is an
 * assumption until someone reads both tables. This script is one half of reading them;
 * `packages/generate/tests/test_unicode_parity.py` is the other half and does the
 * comparing, because only the Python side can say whether a disagreement is about a
 * character it has never heard of.
 *
 * Output format, one section per operation:
 *
 *     # <operation>
 *     <code point in hex> <TAB> <result code points in hex, space separated>
 *
 * Only code points the operation changes are listed. Surrogates are skipped: they are not
 * characters, and the two runtimes disagree about whether they can even be held in a
 * string.
 */

const OPERATIONS = ['NFC', 'NFD', 'NFKC', 'NFKD', 'lowercase'] as const;

function apply(character: string, operation: (typeof OPERATIONS)[number]): string {
  return operation === 'lowercase' ? character.toLowerCase() : character.normalize(operation);
}

const out: string[] = [
  `# runtime node ${process.version} icu ${process.versions.icu} unicode ${process.versions.unicode}`,
];

for (const operation of OPERATIONS) {
  out.push(`# ${operation}`);
  for (let codePoint = 0; codePoint < 0x110000; codePoint += 1) {
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
    const character = String.fromCodePoint(codePoint);
    const result = apply(character, operation);
    if (result === character) continue;
    const mapped = [...result]
      .map((part) => (part.codePointAt(0) as number).toString(16).toUpperCase())
      .join(' ');
    out.push(`${codePoint.toString(16).toUpperCase()}\t${mapped}`);
  }
}

process.stdout.write(out.join('\n') + '\n');
