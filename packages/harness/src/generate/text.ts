// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * Text primitives shared by the declarative verifiers, per spec section 6.0.
 *
 * Every function here exists because JavaScript's built-in answer differs from
 * Python's: `\s` covers a different set from `str.isspace()`, `String.length` counts
 * UTF-16 units rather than code points, and `trim()` and `strip()` disagree about
 * several characters. The spec pins one answer and this module implements it.
 */

/**
 * The spec whitespace set, written out rather than delegated to `\s`.
 * Matches SPEC_WHITESPACE in packages/generate/src/redrob_generate/verify/base.py.
 */
export const SPEC_WHITESPACE =
  '\t\n\v\f\r \u0085\u00a0\u1680' +
  '\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a' +
  '\u2028\u2029\u202f\u205f\u3000';

const WHITESPACE_SET = new Set([...SPEC_WHITESPACE]);

export function isSpecWhitespace(character: string): boolean {
  return WHITESPACE_SET.has(character);
}

/** Strip leading and trailing spec whitespace. */
export function stripSpecWhitespace(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && WHITESPACE_SET.has(text[start] as string)) start += 1;
  while (end > start && WHITESPACE_SET.has(text[end - 1] as string)) end -= 1;
  return text.slice(start, end);
}

/** Replace each run of spec whitespace with a single U+0020. */
export function collapseSpecWhitespace(text: string): string {
  let out = '';
  let inRun = false;
  for (const character of text) {
    if (WHITESPACE_SET.has(character)) {
      if (!inRun) {
        out += ' ';
        inRun = true;
      }
      continue;
    }
    inRun = false;
    out += character;
  }
  return out;
}

/** CRLF then lone CR become LF. Nothing else is a line terminator here. */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Length in Unicode code points.
 *
 * `"\u{1F44D}".length` is 2 and the answer this spec wants is 1.
 */
export function codePointLength(text: string): number {
  let count = 0;
  for (const _character of text) count += 1;
  return count;
}

/**
 * Line count per spec: the empty string has zero lines, and one trailing terminator
 * does not create an empty final line.
 */
export function countLines(text: string): number {
  if (text === '') return 0;
  const parts = text.split('\n');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

export type UnicodeNormalization = 'none' | 'NFC' | 'NFD' | 'NFKC' | 'NFKD';

export function applyUnicodeNormalization(text: string, form: UnicodeNormalization): string {
  return form === 'none' ? text : text.normalize(form);
}

/**
 * Compare two strings by Unicode code point.
 *
 * `Array.prototype.sort`'s default compares UTF-16 code units, which orders
 * `"\u{1F44D}"` before `"\uFFFF"`. Python's `sorted` does not, so canonical JSON key
 * ordering would diverge.
 */
export function compareByCodePoint(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    const x = (a[index] as string).codePointAt(0) as number;
    const y = (b[index] as string).codePointAt(0) as number;
    if (x !== y) return x - y;
  }
  return a.length - b.length;
}
