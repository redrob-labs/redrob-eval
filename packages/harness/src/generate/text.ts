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
import { VerifierConfigError } from './verdict';

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

/**
 * Index of the first unpaired surrogate code unit in `text`, or `-1`.
 *
 * A well-formed pair is not reported; a lead with no trail, a trail with no lead, and a
 * lead followed by another lead all are.
 */
export function findUnpairedSurrogate(text: string): number {
  let index = 0;
  while (index < text.length) {
    const value = text.charCodeAt(index);
    if (value >= 0xd800 && value <= 0xdbff) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 2;
        continue;
      }
      return index;
    }
    if (value >= 0xdc00 && value <= 0xdfff) return index;
    index += 1;
  }
  return -1;
}

/**
 * Refuse a configuration containing an unpaired surrogate, anywhere inside it.
 *
 * An unpaired surrogate is not a character, and the two runtimes disagree about what it is
 * instead. This one holds a string as UTF-16 code units, so `'\u{1f600}'.includes('\ud83d')`
 * is true: the needle is literally the first half of the haystack. Python holds a string as
 * code points, so the same test is false. `String.prototype.split` against a lone-surrogate
 * delimiter splits the same emoji that Python's `str.split` leaves whole. Neither engine is
 * wrong about its own model of a string, so a configuration that can only mean two things is
 * refused rather than evaluated.
 *
 * Candidates are deliberately not checked. A candidate is model output and must always
 * produce a verdict; an unpaired surrogate in a candidate is harmless on its own, because
 * the divergence needs the *needle* to be the half of a pair.
 *
 * Mirrors `require_well_formed` in packages/generate/src/redrob_generate/verify/base.py.
 */
export function requireWellFormed(value: unknown, where = 'verifier configuration'): void {
  if (typeof value === 'string') {
    const position = findUnpairedSurrogate(value);
    if (position >= 0) {
      const code = value.charCodeAt(position).toString(16).toUpperCase().padStart(4, '0');
      throw new VerifierConfigError(
        `${where} contains an unpaired surrogate U+${code} at index ${position}. It is not ` +
          'a character, and a Python implementation matching by code point and a JavaScript ' +
          'one matching by UTF-16 code unit give opposite answers for it',
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) requireWellFormed(entry, where);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      requireWellFormed(key, where);
      requireWellFormed(entry, where);
    }
  }
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

/** Normalisation forms a comparison verifier may declare, per spec section 6.0. */
export const NORMALIZATION_FORMS: readonly UnicodeNormalization[] = [
  'none',
  'NFC',
  'NFD',
  'NFKC',
  'NFKD',
];

/**
 * What a comparison verifier does when it says nothing.
 *
 * NFC rather than none because two answers a reader cannot tell apart must not score
 * differently: Hangul U+AC00 and the jamo pair U+1100 U+1161 render identically and
 * compare unequal without it.
 */
export const DEFAULT_NORMALIZATION: UnicodeNormalization = 'NFC';

export function applyUnicodeNormalization(text: string, form: UnicodeNormalization): string {
  if (form === 'none') return text;
  if (!NORMALIZATION_FORMS.includes(form)) {
    throw new VerifierConfigError(`'${String(form)}' is not a spec unicode normalization form`);
  }
  return text.normalize(form);
}

export function isNormalized(text: string, form: UnicodeNormalization): boolean {
  return applyUnicodeNormalization(text, form) === text;
}

/**
 * Normalise every string and every object key inside parsed JSON.
 *
 * Keys as well as values, because `{"\uac00": 1}` and `{"\u1100\u1161": 1}` are the same
 * object to a reader and different objects to `required` and `properties`.
 */
export function normalizeJsonStrings(value: unknown, form: UnicodeNormalization): unknown {
  if (form === 'none') return value;
  if (typeof value === 'string') return applyUnicodeNormalization(value, form);
  if (Array.isArray(value)) return value.map((entry) => normalizeJsonStrings(entry, form));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[applyUnicodeNormalization(key, form)] = normalizeJsonStrings(entry, form);
    }
    return out;
  }
  return value;
}

/** Units a length bound can be expressed in, per spec section 6.1. */
export const LENGTH_UNITS = ['codepoints', 'utf16', 'graphemes', 'bytes_utf8'] as const;
export type LengthUnit = (typeof LENGTH_UNITS)[number];

/**
 * Length in UTF-8 bytes, counted from code points rather than from `TextEncoder`.
 *
 * `TextEncoder` silently substitutes U+FFFD for a lone surrogate and Python refuses to
 * encode one at all. Both answers are three bytes, but arriving there by arithmetic means
 * the two implementations agree by construction rather than by coincidence.
 */
export function utf8ByteLength(text: string): number {
  let total = 0;
  for (const character of text) {
    const value = character.codePointAt(0) as number;
    if (value < 0x80) total += 1;
    else if (value < 0x800) total += 2;
    else if (value < 0x10000) total += 3;
    else total += 4;
  }
  return total;
}

/** Length of `text` in `unit`. Throws for a unit this implementation refuses. */
export function measureLength(text: string, unit: string): number {
  if (unit === 'codepoints') return codePointLength(text);
  // String.prototype.length is the UTF-16 code unit count by definition.
  if (unit === 'utf16') return text.length;
  if (unit === 'bytes_utf8') return utf8ByteLength(text);
  if (unit === 'graphemes') {
    throw new VerifierConfigError(
      "length_unit 'graphemes' is specified but not supported by this implementation: " +
        "Python's unicodedata and this runtime's ICU carry different Unicode versions, so " +
        'two UAX #29 grapheme breakers would disagree on the emoji and conjunct sequences ' +
        "the unit exists for. Use 'codepoints', 'utf16' or 'bytes_utf8', which are exact " +
        'in both',
    );
  }
  throw new VerifierConfigError(
    `'${unit}' is not a spec length unit; expected one of ${LENGTH_UNITS.join(', ')}`,
  );
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
