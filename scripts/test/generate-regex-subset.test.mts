// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * The parts of the regex subset that cannot be expressed as conformance rows.
 *
 * A case file's verifier must validate against `#/$defs/verifier`, and the schema has no
 * `flags` property at all now, so a row asserting that a flag is refused could not be
 * written there. The same goes for the recorded engine-level facts below, which are about
 * `RegExp` rather than about a verifier.
 *
 * Mirrored by `packages/generate/tests/test_regex_subset.py`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compileSubsetPattern,
  RegexSubsetError,
  runVerifier,
  scanRegexPattern,
  SUPPORTED_REGEX_FLAGS,
  validateRegexFlags,
  validateRegexPattern,
} from '../../packages/harness/src/generate/index';

const SHORTHAND = ['\\w', '\\W', '\\d', '\\D', '\\b', '\\B', '\\s', '\\S'];

for (const shorthand of SHORTHAND) {
  test(`${shorthand} is refused outside a character class`, () => {
    assert.throws(
      () => validateRegexPattern(`a${shorthand}b`),
      (error: unknown) => {
        assert.ok(error instanceof RegexSubsetError);
        assert.match(error.message, /shorthand class/);
        // The error names the offending construct, so the author does not have to guess
        // which of several escapes in a long pattern was the problem.
        assert.ok(error.message.includes(shorthand), `message does not name ${shorthand}`);
        return true;
      },
    );
  });
}

// \b and \B are assertions rather than class shorthands, so they are meaningless inside a
// character class and only the six class shorthands are checked there.
for (const shorthand of ['\\w', '\\W', '\\d', '\\D', '\\s', '\\S']) {
  test(`${shorthand} is refused inside a character class`, () => {
    assert.throws(() => validateRegexPattern(`[${shorthand}-]`), RegexSubsetError);
  });
}

test('the subset has no flags at all', () => {
  assert.deepEqual([...SUPPORTED_REGEX_FLAGS], []);
  for (const flag of ['i', 'm', 's', 'u', 'g']) {
    assert.throws(
      () => validateRegexFlags([flag]),
      (error: unknown) => {
        assert.ok(error instanceof RegexSubsetError);
        assert.match(error.message, /no flags at all/);
        return true;
      },
    );
  }
  assert.doesNotThrow(() => validateRegexFlags([]));
});

test('an out-of-subset flag reaches the verdict as invalid_pattern, never as a pass', () => {
  for (const flag of ['i', 'm']) {
    const verdict = runVerifier({ type: 'regex', pattern: 'abc', flags: [flag] } as never, 'abc');
    assert.equal(verdict.passed, false);
    assert.equal(verdict.code, 'invalid_pattern');
  }
});

test('the compiled source is the pattern verbatim, with no dialect translation', () => {
  // What the author wrote is what runs. A failure here means a translator has crept back
  // in. The one exception in the whole subset is the Python side's '$' to '\Z', which is
  // in the schema_pattern dialect only and is checked in test_regex_subset.py.
  const search = compileSubsetPattern('a[^\\n]b', 'search');
  assert.equal(search.source, 'a[^\\n]b');

  const full = compileSubsetPattern('a[^\\n]b', 'full_match');
  assert.equal(full.source, '^(?:a[^\\n]b)$');
});

test('every pattern compiles under the u flag, which is what puts matching on code points', () => {
  // Without u a RegExp matches UTF-16 code units, and [\u0000-\uffff] then matches the
  // lead surrogate of an astral character while Python's code-point view does not. This
  // is the A1 defect; the assertion below is the fix, stated as behaviour.
  assert.equal(compileSubsetPattern('a', 'search').regexp.flags, 'u');
  assert.equal(
    runVerifier({ type: 'regex', pattern: '[\\u0000-\\uffff]+' } as never, '\u{1F600}').passed,
    false,
  );
  assert.equal(runVerifier({ type: 'regex', pattern: '[^a]' } as never, '\u{1F600}').passed, true);
});

test("the verifier dialect has no '^' and no '$'; anchoring is the mode's job", () => {
  for (const pattern of ['^abc', 'abc$', '^abc$']) {
    const verdict = runVerifier({ type: 'regex', pattern } as never, 'abc');
    assert.equal(verdict.passed, false);
    assert.equal(verdict.code, 'invalid_pattern');
  }
  assert.equal(runVerifier({ type: 'regex', pattern: 'abc' } as never, 'abc').passed, true);
  assert.equal(runVerifier({ type: 'regex', pattern: 'abc' } as never, 'abc\n').passed, false);
});

test("the schema_pattern dialect admits '^' and '$', and the verifier dialect does not", () => {
  assert.doesNotThrow(() => validateRegexPattern('^ab$', [], 'schema_pattern'));
  assert.throws(() => validateRegexPattern('^ab$'), RegexSubsetError);
});

test('surrogate escapes and unpaired surrogates are out of the subset', () => {
  // Under u, '\uD83D\uDE00' is one astral code point to a RegExp and two lone surrogates
  // to Python. Banning the escape is what keeps the two atom models the same.
  assert.throws(() => validateRegexPattern('\\ud83d\\ude00'), RegexSubsetError);
  assert.throws(() => validateRegexPattern('[\\ud800-\\udfff]'), RegexSubsetError);
  assert.throws(() => validateRegexPattern('a\ud83db'), RegexSubsetError);
  // A properly paired literal astral character is fine, and is one atom.
  assert.doesNotThrow(() => validateRegexPattern('a\u{1F600}b'));
});

test('escapes are confined to what a RegExp accepts under u', () => {
  for (const pattern of ['\\-', '\\ ', '\\#', '\\@', '\\_']) {
    assert.throws(() => validateRegexPattern(pattern), RegexSubsetError);
  }
  for (const pattern of ['\\.', '\\$', '\\^', '\\|', '\\/', '\\(', '\\)', '\\[', '\\]']) {
    assert.doesNotThrow(() => validateRegexPattern(pattern), pattern);
  }
  // '-' is escapable inside a class and only there.
  assert.doesNotThrow(() => validateRegexPattern('[a\\-z]'));
});

test('\\0 is out of the subset because Python reads \\01 as an octal escape', () => {
  assert.throws(() => validateRegexPattern('\\0'), RegexSubsetError);
  assert.throws(() => validateRegexPattern('\\01'), RegexSubsetError);
  assert.doesNotThrow(() => validateRegexPattern('\\x00'));
});

test('a quantified lookahead is refused rather than left to the two engines', () => {
  // A syntax error under u and a silent no-op in Python.
  assert.throws(() => validateRegexPattern('(?=a)*'), RegexSubsetError);
  assert.throws(() => validateRegexPattern('(?!a)+'), RegexSubsetError);
  assert.doesNotThrow(() => validateRegexPattern('(?:a)*'));
});

test('a scan concatenates back to its input, which is what makes the one rewrite auditable', () => {
  const patterns = ['a[^\\n]b', '(cat|dog)s?', '[A-Fa-f0-9]{6}', '\\$[0-9]+\\.[0-9]{2}'];
  for (const pattern of patterns) {
    assert.equal(
      scanRegexPattern(pattern)
        .map((token) => token.text)
        .join(''),
      pattern,
    );
  }
  assert.equal(
    scanRegexPattern('^ab$', 'schema_pattern')
      .map((token) => token.text)
      .join(''),
    '^ab$',
  );
});
