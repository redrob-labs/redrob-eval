/**
 * Print the contrast of every theme pairing in both palettes.
 *
 *   yarn verify:theme
 *
 * The assertions live in `scripts/test/theme-contrast.test.mts` and run with `yarn test`.
 * This is the same data as a table, for when a colour needs choosing rather than checking.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONSOLE_FLOOR, MINIMUM, PAIRS, floorFor, ratioFor, readBlocks } from './theme-contrast.mts';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', 'apps', 'web', 'src', 'app', 'globals.css'), 'utf8');

const light = readBlocks(css, ':root');
const dark = { ...light, ...readBlocks(css, "[data-theme='dark']") };

const TOLERANCE = 0.02;

const rows = PAIRS.map(([fg, bg, kind, backdrop]) => {
  const lightRatio = ratioFor(fg, bg, light, backdrop);
  const darkRatio = ratioFor(fg, bg, dark, backdrop);
  const floor = floorFor(fg, bg, kind, lightRatio);
  return { fg, bg, kind, lightRatio, darkRatio, floor, ok: darkRatio >= floor - TOLERANCE };
});

const width = Math.max(...rows.map((r) => `${r.fg} on ${r.bg}`.length));
console.log(`${'pairing'.padEnd(width)}   light    dark   needs`);
for (const r of rows) {
  console.log(
    `${`${r.fg} on ${r.bg}`.padEnd(width)}  ${r.lightRatio.toFixed(2).padStart(5)}  ` +
      `${r.darkRatio.toFixed(2).padStart(5)}  ${r.floor.toFixed(2).padStart(5)}` +
      `${r.ok ? '' : '  <- FAIL'}`,
  );
}

const belowWcag = rows.filter((r) => r.lightRatio < MINIMUM[r.kind]);
if (belowWcag.length) {
  console.log(
    '\nInherited from the light theme, so dark is only held to matching them:\n' +
      belowWcag.map((r) => `  ${r.fg} on ${r.bg} (${r.lightRatio.toFixed(2)}:1)`).join('\n'),
  );
}

const fromConsole = rows.filter((r) => CONSOLE_FLOOR[`${r.fg} on ${r.bg}`] !== undefined);
if (fromConsole.length) {
  console.log(
    "\nFloor is Console's value, not this file's (see CONSOLE_FLOOR):\n" +
      fromConsole
        .map((r) => `  ${r.fg} on ${r.bg} (${CONSOLE_FLOOR[`${r.fg} on ${r.bg}`]}:1)`)
        .join('\n'),
  );
}

const shortfalls = rows.filter((r) => !r.ok);
console.log(
  shortfalls.length === 0
    ? '\nDark meets or beats light on every pairing.'
    : `\n${shortfalls.length} pairing(s) worse in dark than in light.`,
);
process.exit(shortfalls.length === 0 ? 0 : 1);
