/**
 * Contrast floors for the light and dark palettes.
 *
 * A dark palette is easy to get subtly wrong in a way that looks fine to whoever picked
 * the colours and is unreadable to everyone else, so the pairings that carry text are
 * checked as numbers rather than by eye. The tokens are read out of globals.css rather
 * than restated here: a copy of the palette in a test is a copy that goes stale and then
 * passes while the real thing is broken.
 *
 * The report form is `node scripts/check-theme-contrast.mjs`, which prints every
 * pairing as a table.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  MINIMUM,
  PAIRS,
  ratioFor,
  readBlocks,
  type Kind,
} from '../theme-contrast.mts';
import { THEME_SCRIPT, THEME_STORAGE_KEY } from '../../apps/web/src/lib/theme.ts';

const CSS = join(process.cwd(), 'apps', 'web', 'src', 'app', 'globals.css');

const css = readFileSync(CSS, 'utf8');
const light = readBlocks(css, ':root');
const dark = { ...light, ...readBlocks(css, "[data-theme='dark']") };

/** Absorbs rounding where dark is deliberately near-identical to light. */
const TOLERANCE = 0.02;

test('the light palette is present and resolvable', () => {
  assert.ok(Object.keys(light).length > 40, 'expected the :root token block');
  for (const [fg, bg, , backdrop] of PAIRS) {
    assert.ok(
      Number.isFinite(ratioFor(fg, bg, light, backdrop)),
      `could not resolve ${fg} on ${bg} in the light palette`,
    );
  }
});

test('the dark palette overrides the light one rather than replacing it', () => {
  const overrides = readBlocks(css, "[data-theme='dark']");
  assert.ok(Object.keys(overrides).length > 20, 'expected a dark token block');
  for (const name of Object.keys(overrides)) {
    assert.ok(
      name in light,
      `${name} is set for dark but never for light, so light would fall back to nothing`,
    );
  }
});

/**
 * The bar for dark is the bar light already clears.
 *
 * Holding dark to an absolute WCAG floor would fail pairings the light theme has always
 * failed -- hairline borders, muted grey on the page background -- and the only way to
 * pass would be to restyle the light theme, which is not what adding a dark mode is for.
 * So each pairing is judged against the stricter of its WCAG floor and what light
 * manages.
 */
for (const [fg, bg, kind, backdrop] of PAIRS) {
  test(`dark: ${fg} on ${bg}`, () => {
    const lightRatio = ratioFor(fg, bg, light, backdrop);
    const darkRatio = ratioFor(fg, bg, dark, backdrop);
    const floor = Math.min(MINIMUM[kind as Kind], lightRatio);
    assert.ok(
      darkRatio >= floor - TOLERANCE,
      `${fg} on ${bg} is ${darkRatio.toFixed(2)}:1 in dark, below the ` +
        `${floor.toFixed(2)}:1 the light theme manages (${lightRatio.toFixed(2)}:1)`,
    );
  });
}

/**
 * The pre-paint script is the whole reason a dark-mode reload does not flash white.
 * Measured: with it, every frame of a reload is at brightness 33/255; with it removed,
 * every frame is at 234/255. It cannot be replaced by an effect, because effects run
 * after paint, so these assertions guard where it lives rather than what it does.
 */
test('the theme is applied from the document head, not from an effect', () => {
  const layout = readFileSync(
    join(process.cwd(), 'apps', 'web', 'src', 'app', 'layout.tsx'),
    'utf8',
  );
  const head = layout.indexOf('<head>');
  const body = layout.indexOf('<body');
  // From `<head>`, so the import at the top of the file is not mistaken for the usage.
  const script = layout.indexOf('THEME_SCRIPT', head);
  assert.ok(head !== -1 && body !== -1, 'expected an explicit <head> and <body>');
  assert.ok(script > head && script < body, 'THEME_SCRIPT must be inlined in <head>');
  assert.match(
    layout,
    /suppressHydrationWarning/,
    'the script writes data-theme onto <html> before React sees it, so <html> needs ' +
      'suppressHydrationWarning or every load logs a hydration mismatch',
  );
});

test('the pre-paint script runs before the bundle exists', () => {
  assert.ok(
    !/\bimport\b|\brequire\(/.test(THEME_SCRIPT),
    'the script runs before the bundle, so it cannot depend on one',
  );
});

/**
 * Run the script against a stub document and check what it decides.
 *
 * Executed rather than pattern-matched, because what matters is the resolved theme and
 * a regex over the source cannot tell whether the fallback chain is right.
 */
function runScript(stored: string | null, prefersDark: boolean, storageThrows = false) {
  const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
  const scope = {
    localStorage: {
      getItem(key: string) {
        if (storageThrows) throw new Error('storage blocked');
        return key === THEME_STORAGE_KEY ? stored : null;
      },
    },
    matchMedia: (query: string) => ({ matches: query.includes('dark') && prefersDark }),
    document: { documentElement: root },
  };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'localStorage', THEME_SCRIPT)(
    scope,
    scope.document,
    scope.localStorage,
  );
  return root;
}

test('an explicit choice wins over the operating system', () => {
  assert.equal(runScript('dark', false).dataset.theme, 'dark');
  assert.equal(runScript('light', true).dataset.theme, 'light');
});

test('no choice, or `system`, follows the operating system', () => {
  assert.equal(runScript(null, true).dataset.theme, 'dark');
  assert.equal(runScript(null, false).dataset.theme, 'light');
  assert.equal(runScript('system', true).dataset.theme, 'dark');
  assert.equal(runScript('system', false).dataset.theme, 'light');
});

test('a nonsense stored value does not leave the page unthemed', () => {
  assert.equal(runScript('chartreuse', true).dataset.theme, 'dark');
});

test('blocked storage still produces a theme', () => {
  // Private browsing throws on getItem. Rendering unthemed would be worse than light.
  assert.equal(runScript(null, false, true).dataset.theme, 'light');
});

test('native controls are told which theme they are in', () => {
  // Without this, the browser draws select popups and scrollbars for a light page.
  assert.equal(runScript('dark', false).style.colorScheme, 'dark');
  assert.equal(runScript('light', true).style.colorScheme, 'light');
});

test('every colour in globals.css below the token layer is a token', () => {
  // A literal in a rule is a colour that cannot follow the theme, and it will be the one
  // that glows white in a dark room.
  const body = css.slice(css.indexOf('@theme inline {'));
  const literals = body.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g) ?? [];
  assert.deepEqual(
    literals,
    [],
    `hardcoded colours below the token layer: ${[...new Set(literals)].join(', ')}`,
  );
});
