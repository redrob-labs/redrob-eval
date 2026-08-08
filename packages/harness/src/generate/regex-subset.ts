// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * The portable regex subset, per spec section 6.1.
 *
 * The subset contains no construct whose meaning depends on which engine reads it. That
 * is the whole design rule, and it is why the shorthand classes, `.` and `$` are absent:
 * each of them means something different in Python `re` and in a JavaScript `RegExp`, and
 * the difference is not expressible as a flag.
 *
 * The shorthand classes are the important case for this project. `\w`, `\d` and `\b` are
 * Unicode-aware in Python and ASCII-only in a JavaScript `RegExp` without the `u` flag.
 * Either reading is defensible; neither is portable. Forcing them to agree meant pinning
 * ASCII semantics, and ASCII semantics say that Devanagari and Hangul contain no word
 * characters and no digits, which is wrong for a benchmark whose targets are Hindi,
 * Hinglish and Korean. An explicit `[\u0900-\u097F]` says what it means in both engines
 * and in the reader's head.
 *
 * Because nothing here is dialect-dependent, this module compiles the pattern verbatim.
 * An earlier revision translated `.`, `^`, `$`, `\s` and `\S` into JavaScript source that
 * reproduced Python's semantics. That translator is gone: a layer that rewrites one regex
 * dialect into another is a place bugs hide, and every construct that needed it has been
 * removed from the subset instead.
 *
 * Mirrors packages/generate/src/redrob_generate/verify/regex_subset.py.
 */

/** Escapes for characters that cannot be written literally. Identical in both engines. */
const CHARACTER_ESCAPES = new Set([...'nrtfv0']);
/** Banned with a message of their own, because "not in the subset" is unhelpful when the
 *  construct is one every regex author reaches for by reflex. */
const SHORTHAND_CLASSES = new Set([...'dDwWsSbB']);
const REJECTED_ESCAPE_LETTERS = new Set([...'AZzGpPkNcLUQE123456789']);
const HEX_DIGITS = new Set([...'0123456789abcdefABCDEF']);

/** The only flag in the subset. See {@link validateFlags} for the condition on it. */
export const SUPPORTED_FLAGS = ['i'] as const;

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
  | 'quantifier'
  | 'alternation'
  | 'caret';

export interface Token {
  kind: TokenKind;
  text: string;
}

const ATOM_KINDS = new Set<TokenKind>(['literal', 'class', 'escape', 'close']);

function isAlphanumeric(character: string): boolean {
  return /^[0-9A-Za-z]$/.test(character);
}

function shorthandError(letter: string): RegexSubsetError {
  return new RegexSubsetError(
    `shorthand class \\${letter} is not in the portable subset; write the character ` +
      'class out, for example [0-9] or [\\u0900-\\u097F]. The shorthand classes are ' +
      'Unicode-aware in Python and ASCII-only in JavaScript, and the ASCII reading ' +
      'excludes Devanagari and Hangul',
  );
}

/** Tokenise a pattern or throw {@link RegexSubsetError}. */
export function scan(pattern: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let depth = 0;
  const { length } = pattern;

  const requireAtom = (what: string): void => {
    const previous = tokens[tokens.length - 1];
    if (!previous || !ATOM_KINDS.has(previous.kind)) {
      throw new RegexSubsetError(`quantifier '${what}' does not follow a repeatable atom`);
    }
  };

  while (index < length) {
    const character = pattern[index] as string;

    if (character === '\\') {
      if (index + 1 >= length) throw new RegexSubsetError('pattern ends with a trailing backslash');
      const escaped = pattern[index + 1] as string;
      if (escaped === 'x' || escaped === 'u') {
        const width = escaped === 'x' ? 2 : 4;
        const digits = pattern.slice(index + 2, index + 2 + width);
        if (digits.length !== width || [...digits].some((digit) => !HEX_DIGITS.has(digit))) {
          throw new RegexSubsetError(`malformed \\${escaped} escape`);
        }
        tokens.push({ kind: 'literal', text: pattern.slice(index, index + 2 + width) });
        index += 2 + width;
        continue;
      }
      if (isAlphanumeric(escaped)) {
        if (SHORTHAND_CLASSES.has(escaped)) throw shorthandError(escaped);
        if (REJECTED_ESCAPE_LETTERS.has(escaped)) {
          throw new RegexSubsetError(
            `escape \\${escaped} is outside the portable subset ` +
              '(backreferences, \\A \\Z \\z \\G and \\p are not allowed)',
          );
        }
        if (!CHARACTER_ESCAPES.has(escaped)) {
          throw new RegexSubsetError(`escape \\${escaped} is not in the portable subset`);
        }
        tokens.push({ kind: 'escape', text: `\\${escaped}` });
        index += 2;
        continue;
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
          depth += 1;
          continue;
        }
        throw new RegexSubsetError(
          `group '(?${marker}' is outside the portable subset ` +
            '(named groups, lookbehind, atomic groups and inline flags are not allowed)',
        );
      }
      tokens.push({ kind: 'group', text: '(' });
      index += 1;
      depth += 1;
      continue;
    }

    if (character === ')') {
      if (depth === 0) throw new RegexSubsetError("unbalanced ')'");
      depth -= 1;
      tokens.push({ kind: 'close', text: ')' });
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
          '[^\\n] for any character but a newline or [\\u0000-\\uffff] for any character. ' +
          "Python excludes only the newline from '.' while JavaScript also excludes CR, " +
          'U+2028 and U+2029',
      );
    }

    if (character === '^') {
      tokens.push({ kind: 'caret', text: '^' });
      index += 1;
      continue;
    }

    if (character === '$') {
      throw new RegexSubsetError(
        "'$' is not in the portable subset; use mode 'full_match' to anchor the end of " +
          "the candidate. Python's '$' also matches before one trailing newline and " +
          "JavaScript's does not",
      );
    }

    if (character === '|') {
      tokens.push({ kind: 'alternation', text: '|' });
      index += 1;
      continue;
    }

    tokens.push({ kind: 'literal', text: character });
    index += 1;
  }

  if (depth !== 0) throw new RegexSubsetError("unbalanced '('");
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
        index += 2 + width;
        continue;
      }
      if (isAlphanumeric(escaped)) {
        if (SHORTHAND_CLASSES.has(escaped)) throw shorthandError(escaped);
        if (!CHARACTER_ESCAPES.has(escaped)) {
          throw new RegexSubsetError(`escape \\${escaped} is not allowed inside a character class`);
        }
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
 * Throw unless every flag is in the subset and permitted for this pattern.
 *
 * `i` is confined to ASCII-only patterns. Case folding is the one remaining place the two
 * engines disagree: a JavaScript `RegExp` without the `u` flag folds Greek and Cyrillic
 * but refuses to fold a non-ASCII character down to an ASCII one, while Python under
 * `re.ASCII` folds nothing outside ASCII at all. Restricted to an ASCII pattern the two
 * coincide exactly, and outside it they cannot be made to without a translator.
 *
 * Nothing is lost for this project's targets, since Devanagari and Hangul are caseless.
 */
export function validateFlags(pattern: string, flags: readonly string[] = []): void {
  if (!Array.isArray(flags)) throw new RegexSubsetError('flags must be a list');
  for (const flag of flags) {
    if (!(SUPPORTED_FLAGS as readonly string[]).includes(flag)) {
      throw new RegexSubsetError(
        `flag '${flag}' is not in the portable subset; the subset has no 'm' or 's' ` +
          "because it has no '$' or '.' for them to modify",
      );
    }
  }
  // eslint-disable-next-line no-control-regex
  if (flags.includes('i') && /[^\u0000-\u007f]/.test(pattern)) {
    throw new RegexSubsetError(
      "flag 'i' is only permitted on an ASCII-only pattern, because the two engines fold " +
        'non-ASCII case differently; write the alternatives out explicitly',
    );
  }
}

/** Throw if a pattern is outside the portable subset. */
export function validate(pattern: string, flags: readonly string[] = []): void {
  scan(pattern);
  validateFlags(pattern, flags);
}

export interface CompiledPattern {
  regexp: RegExp;
  source: string;
}

/**
 * Compile a subset pattern for one of the two modes.
 *
 * The pattern is passed to `RegExp` verbatim. `full_match` wraps it in `^(?:...)$`, which
 * is anchoring for the mode rather than a dialect translation: with no `m` flag the
 * JavaScript `$` means end of input, which is exactly what Python's `fullmatch` means and
 * is not what `re.search(r'...$')` means. The `u` flag is never set, so a `\uHHHH` escape
 * is a code unit in both engines.
 */
export function compileSubsetPattern(
  pattern: string,
  mode: 'full_match' | 'search',
  flags: readonly string[],
): CompiledPattern {
  scan(pattern);
  validateFlags(pattern, flags);
  const source = mode === 'full_match' ? `^(?:${pattern})$` : pattern;
  const jsFlags = flags.includes('i') ? 'i' : '';
  try {
    return { regexp: new RegExp(source, jsFlags), source };
  } catch (error) {
    throw new RegexSubsetError(
      `pattern did not compile: ${(error as Error).message} (source ${source})`,
    );
  }
}
