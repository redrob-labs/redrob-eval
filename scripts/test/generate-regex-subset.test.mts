// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * The parts of the regex subset that cannot be expressed as conformance rows.
 *
 * A case file's verifier must validate against `#/$defs/verifier`, and the schema now
 * restricts `flags` to `["i"]`, so a row asserting that `m` and `s` are refused could not
 * be written there. It is asserted here instead, and mirrored by
 * `test_regex_subset.py::test_the_m_and_s_flags_are_gone`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compileSubsetPattern,
  RegexSubsetError,
  runVerifier,
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

test('the m and s flags are gone from the subset', () => {
  for (const flag of ['m', 's']) {
    assert.throws(
      () => validateRegexFlags('abc', [flag]),
      (error: unknown) => {
        assert.ok(error instanceof RegexSubsetError);
        assert.match(error.message, /not in the portable subset/);
        return true;
      },
    );
  }
  assert.deepEqual([...SUPPORTED_REGEX_FLAGS], ['i']);
});

test('the i flag is refused on a non-ASCII pattern', () => {
  assert.doesNotThrow(() => validateRegexFlags('abc', ['i']));
  assert.throws(() => validateRegexFlags('\u00e9t\u00e9', ['i']), RegexSubsetError);
  // Without the flag the same pattern is fine; it is the folding that is unportable.
  assert.doesNotThrow(() => validateRegexPattern('\u00e9t\u00e9'));
});

test('an out-of-subset flag reaches the verdict as invalid_pattern, never as a pass', () => {
  const verdict = runVerifier(
    { type: 'regex', pattern: 'abc', flags: ['m'] } as never,
    'abc',
  );
  assert.equal(verdict.passed, false);
  assert.equal(verdict.code, 'invalid_pattern');
});

test('the compiled source is the pattern verbatim, with no dialect translation', () => {
  // The point of removing the rewriting layer: what the author wrote is what runs. A
  // failure here means a translator has crept back in.
  const search = compileSubsetPattern('a[^\\n]b', 'search', []);
  assert.equal(search.source, 'a[^\\n]b');

  const full = compileSubsetPattern('a[^\\n]b', 'full_match', []);
  assert.equal(full.source, '^(?:a[^\\n]b)$');
});

test('the portable end-of-input assertion behaves the same as Python across a trailing newline', () => {
  // (?![\u0000-\uffff]) replaces '$', which the two engines read differently. The Python
  // half of this assertion is test_regex_subset.py::test_the_portable_end_assertion.
  const anchored = { type: 'regex', pattern: '^ab(?![\\u0000-\\uffff])', mode: 'search' } as never;
  assert.equal(runVerifier(anchored, 'ab').passed, true);
  assert.equal(runVerifier(anchored, 'ab\n').passed, false);
  assert.equal(runVerifier(anchored, 'abc').passed, false);
});
