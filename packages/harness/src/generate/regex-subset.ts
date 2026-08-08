// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * The portable regex subset, per spec section 6.1.
 *
 * The subset contains no construct whose meaning depends on which engine reads it. That
 * is the whole design rule. It is why the shorthand classes, `.`, `^`, `$` and every flag
 * are absent from the standalone regex verifier: each of them means something different
 * in Python `re` and in a JavaScript `RegExp`, and the difference is not expressible as a
 * flag.
 *
 * Two premises had to be fixed before the rule was actually true.
 *
 * The first is the unit of matching. Without the `u` flag a `RegExp` matches UTF-16 code
 * units, so `[\u0000-\uffff]` matches the lead surrogate of an astral character while
 * Python's code-point view does not. This module now compiles with `u`, which puts both
 * engines on code points, and the scanner rejects the two constructs `u` reinterprets
 * rather than shares: `\uD800`-`\uDFFF` escapes, which `u` reads as halves of a surrogate
 * pair, and unpaired surrogate code points in the pattern source.
 *
 * The second is case folding. Under `u` a `RegExp` folds with Unicode simple case folding
 * and Python's `re.IGNORECASE` folds with its own table; they agree on the Kelvin sign,
 * the long s and final sigma, and disagree on U+0130 and U+0131, the Turkish dotted and
 * dotless I. No pattern-side restriction can exclude those, because they arrive in the
 * candidate. `i` is therefore gone, and case insensitivity is written out as `[kK]`.
 *
 * Two dialects exist. `verifier` is the standalone regex verifier and has no anchors, the
 * mode does that job. `schema_pattern` is the JSON Schema `pattern` keyword, where `^...$`
 * is idiomatic; there `^` means start of input and `$` means absolute end of input, which
 * a `RegExp` without `m` already does, so this side emits the pattern verbatim and the
 * Python side rewrites the single `$` token to `\Z`.
 *
 * Mirrors packages/generate/src/redrob_generate/verify/regex_subset.py.
 */

/** Escapes for characters that cannot be written literally. Identical in both engines.
 *  `\0` is absent: Python reads `\01` as an octal escape and JavaScript rejects it. */
const CHARACTER_ESCAPES = new Set([...'nrtfv']);
/** Banned with a message of their own, because "not in the subset" is unhelpful when the
 *  construct is one every regex author reaches for by reflex. */
const SHORTHAND_CLASSES = new Set([...'dDwWsSbB']);
const REJECTED_ESCAPE_LETTERS = new Set([...'AZzGpPkNcLUQE0123456789']);
const HEX_DIGITS = new Set([...'0123456789abcdefABCDEF']);

/** Punctuation that may be escaped: exactly what a `RegExp` accepts under `u`. */
const IDENTITY_ESCAPES = new Set([...'^$\\.*+?()[]{}|/']);
/** `-` is additionally escapable inside a character class, and only there. */
const CLASS_IDENTITY_ESCAPES = new Set([...IDENTITY_ESCAPES, '-']);

export type RegexDialect = 'verifier' | 'schema_pattern';
export const DIALECTS: readonly RegexDialect[] = ['verifier', 'schema_pattern'];

/** The standalone regex verifier has no flags at all. */
export const SUPPORTED_FLAGS: readonly string[] = [];

export class RegexSubsetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegexSubsetError';
  }
}

type TokenKind =
  | 'literal'
  | 'escape'
  | 'class'
  | 'group'
  | 'close'
  | 'close_assertion'
  | 'quantifier'
  | 'alternation'
  | 'caret'
  | 'dollar';

export interface Token {
  kind: TokenKind;
  text: string;
}

/** Kinds a quantifier may follow. `close_assertion` is deliberately absent: a quantified
 *  lookahead is a syntax error under `u` and a no-op in Python. */
const ATOM_KINDS = new Set<TokenKind>(['literal', 'class', 'escape', 'close']);

function isAlphanumeric(character: string): boolean {
  return /^[0-9A-Za-z]$/.test(character);
}

function isSurrogate(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 0xd800 && code <= 0xdfff;
}

function shorthandError(letter: string): RegexSubsetError {
  return new RegexSubsetError(
    `shorthand class \\${letter} is not in the portable subset; write the character ` +
      'class out, for example [0-9] or [\\u0900-\\u097F]. The shorthand classes are ' +
      'Unicode-aware in Python and ASCII-only in JavaScript, and the ASCII reading ' +
      'excludes Devanagari and Hangul',
  );
}

function surrogateEscapeError(value: number): RegexSubsetError {
  return new RegexSubsetError(
    `\\u${value.toString(16).toUpperCase().padStart(4, '0')} is a surrogate code point and ` +
      'is not in the portable subset; write the character itself. Under the u flag ' +
      'JavaScript reads an adjacent surrogate pair as one astral code point and Python ' +
      'reads it as two',
  );
}

function checkDialect(dialect: string): void {
  if (dialect !== 'verifier' && dialect !== 'schema_pattern') {
    throw new RegexSubsetError(
      `'${dialect}' is not a regex dialect; expected one of ${DIALECTS.join(', ')}`,
    );
  }
}

/**
 * Tokenise a pattern or throw {@link RegexSubsetError}.
 *
 * The token texts concatenate back to the input exactly, which is what makes the one
 * permitted rewrite on the Python side checkable.
 */
export function scan(pattern: string, dialect: RegexDialect = 'verifier'): Token[] {
  checkDialect(dialect);
  if (typeof pattern !== 'string') throw new RegexSubsetError('a pattern must be a string');

  const tokens: Token[] = [];
  let index = 0;
  const openGroups: boolean[] = []; // true when the group is a lookahead assertion
  const { length } = pattern;

  const requireAtom = (what: string): void => {
    const previous = tokens[tokens.length - 1];
    if (previous?.kind === 'close_assertion') {
      throw new RegexSubsetError(
        `quantifier '${what}' follows a lookahead; a quantified assertion is a syntax ` +
          'error in JavaScript under the u flag and a no-op in Python',
      );
    }
    if (!previous || !ATOM_KINDS.has(previous.kind)) {
      throw new RegexSubsetError(`quantifier '${what}' does not follow a repeatable atom`);
    }
  };

  while (index < length) {
    const character = pattern[index] as string;

    if (isSurrogate(character)) {
      // Only reachable for an unpaired surrogate: a pair is one code point and the loop
      // below advances past both units as literals.
      const paired =
        character.charCodeAt(0) <= 0xdbff &&
        index + 1 < length &&
        (pattern.charCodeAt(index + 1) & 0xfc00) === 0xdc00;
      if (!paired) {
        throw new RegexSubsetError(
          'the pattern contains an unpaired surrogate code point U+' +
            character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0') +
            '; the two engines do not agree on what one matches',
        );
      }
      tokens.push({ kind: 'literal', text: pattern.slice(index, index + 2) });
      index += 2;
      continue;
    }

    if (character === '\\') {
      if (index + 1 >= length) throw new RegexSubsetError('pattern ends with a trailing backslash');
      const escaped = pattern[index + 1] as string;
      if (escaped === 'x' || escaped === 'u') {
        const width = escaped === 'x' ? 2 : 4;
        const digits = pattern.slice(index + 2, index + 2 + width);
        if (digits.length !== width || [...digits].some((digit) => !HEX_DIGITS.has(digit))) {
          throw new RegexSubsetError(`malformed \\${escaped} escape`);
        }
        const value = Number.parseInt(digits, 16);
        if (value >= 0xd800 && value <= 0xdfff) throw surrogateEscapeError(value);
        tokens.push({ kind: 'literal', text: pattern.slice(index, index + 2 + width) });
        index += 2 + width;
        continue;
      }
      if (isAlphanumeric(escaped)) {
        if (SHORTHAND_CLASSES.has(escaped)) throw shorthandError(escaped);
        if (REJECTED_ESCAPE_LETTERS.has(escaped)) {
          throw new RegexSubsetError(
            `escape \\${escaped} is outside the portable subset ` +
              '(backreferences, \\0, \\A \\Z \\z \\G and \\p are not allowed)',
          );
        }
        if (!CHARACTER_ESCAPES.has(escaped)) {
          throw new RegexSubsetError(`escape \\${escaped} is not in the portable subset`);
        }
        tokens.push({ kind: 'escape', text: `\\${escaped}` });
        index += 2;
        continue;
      }
      if (!IDENTITY_ESCAPES.has(escaped)) {
        throw new RegexSubsetError(
          `escape \\${escaped} is not in the portable subset; only ` +
            '^ $ \\ . * + ? ( ) [ ] { } | / may be escaped, because a JavaScript RegExp ' +
            'under the u flag rejects every other escaped punctuation mark',
        );
      }
      tokens.push({ kind: 'literal', text: `\\${escaped}` });
      index += 2;
      continue;
    }

    if (character === '[') {
      const [body, consumed] = scanClass(pattern, index);
      tokens.push({ kind: 'class', text: body });
      index += consumed;
      continue;
    }

    if (character === ']') {
      throw new RegexSubsetError("unescaped ']' outside a character class");
    }

    if (character === '(') {
      if (pattern.startsWith('(?', index)) {
        const marker = pattern.slice(index + 2, index + 3);
        if (marker === ':' || marker === '=' || marker === '!') {
          tokens.push({ kind: 'group', text: pattern.slice(index, index + 3) });
          index += 3;
          openGroups.push(marker === '=' || marker === '!');
          continue;
        }
        throw new RegexSubsetError(
          `group '(?${marker}' is outside the portable subset ` +
            '(named groups, lookbehind, atomic groups and inline flags are not allowed)',
        );
      }
      tokens.push({ kind: 'group', text: '(' });
      index += 1;
      openGroups.push(false);
      continue;
    }

    if (character === ')') {
      if (openGroups.length === 0) throw new RegexSubsetError("unbalanced ')'");
      const wasAssertion = openGroups.pop() as boolean;
      tokens.push({ kind: wasAssertion ? 'close_assertion' : 'close', text: ')' });
      index += 1;
      continue;
    }

    if (character === '*' || character === '+' || character === '?') {
      requireAtom(character);
      let text = character;
      index += 1;
      if (index < length && pattern[index] === '?') {
        text += '?';
        index += 1;
      } else if (index < length && pattern[index] === '+') {
        throw new RegexSubsetError('possessive quantifiers are not in the portable subset');
      }
      tokens.push({ kind: 'quantifier', text });
      continue;
    }

    if (character === '{') {
      const [body, consumed] = scanBraceQuantifier(pattern, index);
      requireAtom(body);
      index += consumed;
      let text = body;
      if (index < length && pattern[index] === '?') {
        text += '?';
        index += 1;
      } else if (index < length && pattern[index] === '+') {
        throw new RegexSubsetError('possessive quantifiers are not in the portable subset');
      }
      tokens.push({ kind: 'quantifier', text });
      continue;
    }

    if (character === '}') {
      throw new RegexSubsetError("unescaped '}' outside a quantifier");
    }

    if (character === '.') {
      throw new RegexSubsetError(
        "'.' is not in the portable subset; write the character class out, for example " +
          "[^\\n] for any character but a newline. Python excludes only the newline from '.' " +
          'while JavaScript also excludes CR, U+2028 and U+2029',
      );
    }

    if (character === '^') {
      if (dialect !== 'schema_pattern') {
        throw new RegexSubsetError(
          "'^' is not in the portable subset for the regex verifier; anchoring is the job " +
            "of 'mode', so use mode 'full_match' rather than an anchor in the pattern",
        );
      }
      tokens.push({ kind: 'caret', text: '^' });
      index += 1;
      continue;
    }

    if (character === '$') {
      if (dialect !== 'schema_pattern') {
        throw new RegexSubsetError(
          "'$' is not in the portable subset for the regex verifier; use mode 'full_match' " +
            "to anchor the end of the candidate. Python's '$' also matches before one " +
            "trailing newline and JavaScript's does not",
        );
      }
      tokens.push({ kind: 'dollar', text: '$' });
      index += 1;
      continue;
    }

    if (character === '|') {
      tokens.push({ kind: 'alternation', text: '|' });
      index += 1;
      continue;
    }

    tokens.push({ kind: 'literal', text: character });
    index += 1;
  }

  if (openGroups.length > 0) throw new RegexSubsetError("unbalanced '('");
  return tokens;
}

function scanClass(pattern: string, start: number): [string, number] {
  let index = start + 1;
  const { length } = pattern;
  if (index < length && pattern[index] === '^') index += 1;
  if (index < length && pattern[index] === ']') {
    // Python rejects '[]]' and JavaScript reads it as an empty class followed by a
    // literal ']'. Requiring the escape is the only reading both engines share.
    throw new RegexSubsetError("']' must be escaped inside a character class");
  }
  while (index < length) {
    const character = pattern[index] as string;
    if (isSurrogate(character)) {
      const paired =
        character.charCodeAt(0) <= 0xdbff &&
        index + 1 < length &&
        (pattern.charCodeAt(index + 1) & 0xfc00) === 0xdc00;
      if (!paired) {
        throw new RegexSubsetError(
          'the character class contains an unpaired surrogate code point U+' +
            character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0') +
            '; the two engines do not agree on what one matches',
        );
      }
      index += 2;
      continue;
    }
    if (character === '\\') {
      if (index + 1 >= length) {
        throw new RegexSubsetError('character class ends with a trailing backslash');
      }
      const escaped = pattern[index + 1] as string;
      if (escaped === 'x' || escaped === 'u') {
        const width = escaped === 'x' ? 2 : 4;
        const digits = pattern.slice(index + 2, index + 2 + width);
        if (digits.length !== width || [...digits].some((digit) => !HEX_DIGITS.has(digit))) {
          throw new RegexSubsetError(`malformed \\${escaped} escape in character class`);
        }
        const value = Number.parseInt(digits, 16);
        if (value >= 0xd800 && value <= 0xdfff) throw surrogateEscapeError(value);
        index += 2 + width;
        continue;
      }
      if (isAlphanumeric(escaped)) {
        if (SHORTHAND_CLASSES.has(escaped)) throw shorthandError(escaped);
        if (!CHARACTER_ESCAPES.has(escaped)) {
          throw new RegexSubsetError(`escape \\${escaped} is not allowed inside a character class`);
        }
      } else if (!CLASS_IDENTITY_ESCAPES.has(escaped)) {
        throw new RegexSubsetError(
          `escape \\${escaped} is not allowed inside a character class; only ` +
            '^ $ \\ . * + ? ( ) [ ] { } | / and - may be escaped there',
        );
      }
      index += 2;
      continue;
    }
    if (character === '[') {
      throw new RegexSubsetError("nested '[' must be escaped inside a character class");
    }
    if (character === ']') {
      return [pattern.slice(start, index + 1), index + 1 - start];
    }
    index += 1;
  }
  throw new RegexSubsetError('unterminated character class');
}

function scanBraceQuantifier(pattern: string, start: number): [string, number] {
  const end = pattern.indexOf('}', start);
  if (end === -1) throw new RegexSubsetError("unescaped '{' that is not a quantifier");
  const body = pattern.slice(start + 1, end);
  const parts = body.split(',');
  const isDigits = (value: string) => value.length > 0 && /^[0-9]+$/.test(value);
  if (parts.length > 2 || !isDigits(parts[0] as string)) {
    throw new RegexSubsetError("unescaped '{' that is not a quantifier");
  }
  if (parts.length === 2 && parts[1] !== '' && !isDigits(parts[1] as string)) {
    throw new RegexSubsetError("unescaped '{' that is not a quantifier");
  }
  if (parts.length === 2 && isDigits(parts[1] as string) && Number(parts[1]) < Number(parts[0])) {
    throw new RegexSubsetError('quantifier maximum is below its minimum');
  }
  return [pattern.slice(start, end + 1), end + 1 - start];
}

/**
 * Throw unless `flags` is empty.
 *
 * There is no flag in the subset. `i` was the last one and it is gone: see the module
 * comment for the U+0130 and U+0131 divergence that no pattern-side rule can exclude.
 */
export function validateFlags(flags: readonly string[] = []): void {
  if (!Array.isArray(flags)) throw new RegexSubsetError('flags must be a list');
  if (flags.length > 0) {
    throw new RegexSubsetError(
      `flag '${flags[0]}' is not in the portable subset; the subset has no flags at all. ` +
        'Write case insensitivity out as [kK], which folds identically in both engines, ' +
        "and anchoring as mode 'full_match'",
    );
  }
}

/** Throw if a pattern is outside the portable subset. */
export function validate(
  pattern: string,
  flags: readonly string[] = [],
  dialect: RegexDialect = 'verifier',
): void {
  scan(pattern, dialect);
  validateFlags(flags);
}

export interface CompiledPattern {
  regexp: RegExp;
  source: string;
}

/**
 * Compile a subset pattern for one of the two modes.
 *
 * The pattern is passed to `RegExp` verbatim under the `u` flag, which is what makes a
 * match unit a code point here as it already is in Python. `full_match` wraps it in
 * `^(?:...)$`, which is anchoring for the mode rather than a dialect translation: with no
 * `m` flag `$` means end of input, which is exactly what Python's `fullmatch` means.
 */
export function compileSubsetPattern(
  pattern: string,
  mode: 'full_match' | 'search',
  dialect: RegexDialect = 'verifier',
): CompiledPattern {
  scan(pattern, dialect);
  const source = mode === 'full_match' ? `^(?:${pattern})$` : pattern;
  try {
    return { regexp: new RegExp(source, 'u'), source };
  } catch (error) {
    throw new RegexSubsetError(
      `pattern did not compile: ${(error as Error).message} (source ${source})`,
    );
  }
}
