// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * The portable regex subset, per spec section 6.1.
 *
 * Python `re` under `re.ASCII` is the normative engine, so this module does two jobs:
 * it rejects the same patterns the Python scanner rejects, and it rewrites the ones it
 * accepts so that a plain JavaScript `RegExp` reproduces Python's semantics.
 *
 * The four rewrites, each pinned by conformance cases:
 *
 *   `.`      -> `[^\n]`, or `[\s\S]` with the s flag; the JS `s` flag is never used,
 *              because JS excludes CR and the Unicode line separators from `.` and
 *              Python does not.
 *   `^`      -> `(?:^|(?<=\n))` with the m flag; the JS `m` flag is never used, because
 *              it also anchors around CR, U+2028 and U+2029.
 *   `$`      -> `(?=\n|$)` with m, `(?=\n?$)` without; Python's `$` matches before a
 *              single trailing newline and JavaScript's does not.
 *   `\s` `\S`-> explicit classes; `re.ASCII` makes Python's `\s` ASCII-only while
 *              JavaScript's stays Unicode-aware.
 *
 * Mirrors packages/generate/src/redrob_generate/verify/regex_subset.py.
 */

const CLASS_ESCAPES = new Set([...'dDwWsnrtfv0']);
const ATOM_ESCAPES = new Set([...'dDwWsSbBnrtfv0']);
const REJECTED_ESCAPE_LETTERS = new Set([...'AZzGpPkNcLUQEB123456789']);
const HEX_DIGITS = new Set([...'0123456789abcdefABCDEF']);

/** ASCII whitespace, spelled out because the two engines disagree about `\s`. */
const ASCII_WHITESPACE_CLASS_BODY = ' \\t\\n\\r\\f\\v';

export class RegexSubsetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegexSubsetError';
  }
}

type TokenKind =
  | 'literal'
  | 'escape'
  | 'anchor'
  | 'class'
  | 'group'
  | 'close'
  | 'quantifier'
  | 'alternation'
  | 'dot'
  | 'caret'
  | 'dollar';

export interface Token {
  kind: TokenKind;
  text: string;
}

const ATOM_KINDS = new Set<TokenKind>(['literal', 'dot', 'class', 'escape', 'close']);

function isAlphanumeric(character: string): boolean {
  return /^[0-9A-Za-z]$/.test(character);
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
        if (REJECTED_ESCAPE_LETTERS.has(escaped)) {
          throw new RegexSubsetError(
            `escape \\${escaped} is outside the portable subset ` +
              '(backreferences, \\A \\Z \\z \\G and \\p are not allowed)',
          );
        }
        if (!ATOM_ESCAPES.has(escaped)) {
          throw new RegexSubsetError(`escape \\${escaped} is not in the portable subset`);
        }
        tokens.push({
          kind: escaped === 'b' || escaped === 'B' ? 'anchor' : 'escape',
          text: `\\${escaped}`,
        });
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
      tokens.push({ kind: 'dot', text: '.' });
      index += 1;
      continue;
    }
    if (character === '^') {
      tokens.push({ kind: 'caret', text: '^' });
      index += 1;
      continue;
    }
    if (character === '$') {
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
        if (escaped === 'S') {
          throw new RegexSubsetError(
            '\\S inside a character class is outside the portable subset',
          );
        }
        if (!CLASS_ESCAPES.has(escaped)) {
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
  if (
    parts.length === 2 &&
    isDigits(parts[1] as string) &&
    Number(parts[1]) < Number(parts[0])
  ) {
    throw new RegexSubsetError('quantifier maximum is below its minimum');
  }
  return [pattern.slice(start, end + 1), end + 1 - start];
}

/** Throw if a pattern is outside the portable subset. */
export function validate(pattern: string): void {
  scan(pattern);
}

function rewriteClassBody(body: string): string {
  let out = '';
  let index = 0;
  while (index < body.length) {
    const character = body[index] as string;
    if (character === '\\') {
      const escaped = body[index + 1] as string;
      if (escaped === 's') {
        out += ASCII_WHITESPACE_CLASS_BODY;
        index += 2;
        continue;
      }
      out += character + escaped;
      index += 2;
      continue;
    }
    out += character;
    index += 1;
  }
  return out;
}

export interface RewriteOptions {
  multiline: boolean;
  dotAll: boolean;
}

/** Translate a subset pattern into JavaScript source with Python `re` semantics. */
export function rewrite(tokens: readonly Token[], options: RewriteOptions): string {
  let out = '';
  for (const token of tokens) {
    switch (token.kind) {
      case 'dot':
        out += options.dotAll ? '[\\s\\S]' : '[^\\n]';
        break;
      case 'caret':
        out += options.multiline ? '(?:^|(?<=\\n))' : '^';
        break;
      case 'dollar':
        out += options.multiline ? '(?=\\n|$)' : '(?=\\n?$)';
        break;
      case 'escape':
        if (token.text === '\\s') out += `[${ASCII_WHITESPACE_CLASS_BODY}]`;
        else if (token.text === '\\S') out += `[^${ASCII_WHITESPACE_CLASS_BODY}]`;
        else out += token.text;
        break;
      case 'class':
        out += rewriteClassBody(token.text);
        break;
      default:
        out += token.text;
    }
  }
  return out;
}

export interface CompiledPattern {
  regexp: RegExp;
  source: string;
}

/**
 * Compile a subset pattern for one of the two modes.
 *
 * `full_match` anchors with `^(?:...)$`, where the JavaScript `$` means end of input
 * because the `m` flag is never passed. That is exactly Python's `fullmatch`, which
 * unlike `re.match(r'...$')` does not allow a trailing newline.
 */
export function compileSubsetPattern(
  pattern: string,
  mode: 'full_match' | 'search',
  flags: readonly string[],
): CompiledPattern {
  const tokens = scan(pattern);
  const multiline = flags.includes('m');
  const dotAll = flags.includes('s');
  const body = rewrite(tokens, { multiline, dotAll });
  const source = mode === 'full_match' ? `^(?:${body})$` : body;
  const jsFlags = flags.includes('i') ? 'i' : '';
  try {
    return { regexp: new RegExp(source, jsFlags), source };
  } catch (error) {
    throw new RegexSubsetError(
      `rewritten pattern did not compile: ${(error as Error).message} (source ${source})`,
    );
  }
}
