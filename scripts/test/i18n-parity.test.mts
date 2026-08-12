import assert from 'node:assert/strict';
import test from 'node:test';

import { en } from '../../apps/web/src/lib/i18n/en.ts';
import { ko } from '../../apps/web/src/lib/i18n/ko.ts';

/**
 * `translate` falls back to English for a missing key, so a gap here is silent
 * at runtime: the Korean UI just shows an English sentence in the middle of a
 * Korean screen. The reverse leaves dead strings behind after a rename.
 */
test('every English key has a Korean translation and nothing more', () => {
  const enKeys = Object.keys(en);
  const koKeys = Object.keys(ko);

  assert.deepEqual(
    enKeys.filter((k) => !(k in ko)),
    [],
    'these keys would render in English on a Korean screen',
  );
  assert.deepEqual(
    koKeys.filter((k) => !(k in en)),
    [],
    'these Korean strings are no longer referenced',
  );
});

test('no message uses an em dash or en dash', () => {
  for (const [key, value] of Object.entries({ ...en, ...ko })) {
    assert.doesNotMatch(String(value), /[—–]/, `${key} uses a long dash`);
  }
});

test('a translation keeps the placeholders its English original declares', () => {
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
  for (const [key, value] of Object.entries(en)) {
    const translated = (ko as Record<string, string>)[key];
    if (!translated) continue;
    // A dropped placeholder renders as a sentence with a hole in it.
    assert.deepEqual(
      placeholders(translated),
      placeholders(String(value)),
      `${key} does not interpolate the same values`,
    );
  }
});
