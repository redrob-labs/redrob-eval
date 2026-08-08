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
