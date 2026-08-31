/**
 * One product, one palette.
 *
 * Redrob Eval and Redrob Console are two front doors to the same product, and a person who
 * learns a colour in one is entitled to find it unchanged in the other. Console keeps the
 * tokens in `apps/web/src/app/globals.css`; Eval keeps the same bands at the top of its own
 * `apps/web/src/app/globals.css`, primitives first, then semantic roles, then the local
 * names the 4,300 lines of rules below already spell.
 *
 * Two repositories cannot import from each other, so this file is the joint. Every value
 * Console declares is written out below, transcribed from its stylesheet, and each test
 * checks Eval's copy against it. If either side changes a colour alone, this fails and
 * names the token.
 *
 * What it does not check: that the two products look alike. They do not, and should not;
 * Eval is a three-pane workbench and Console is a marketing site with a dashboard behind
 * it. What it checks is that where they paint the same role they reach for the same value,
 * that a role is decided in exactly one place, and that no surface reaches past the tokens
 * for a colour of its own.
 *
 * The contrast floors are a separate concern and live in `theme-contrast.test.mts`.
 */

import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = process.cwd();
const SRC = join(ROOT, 'apps', 'web', 'src');
const CSS_PATH = join(SRC, 'app', 'globals.css');
const LAYOUT_PATH = join(SRC, 'app', 'layout.tsx');

const css = readFileSync(CSS_PATH, 'utf8');
const layout = readFileSync(LAYOUT_PATH, 'utf8');

/** Strip comments, so a value quoted in prose is never mistaken for a declaration. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * The declarations of every rule with this selector, read to the matching closing brace and
 * merged. Merged because the token layer states `:root` more than once: primitives, then
 * roles, then the local names, so each band can carry its own heading.
 */
function declarations(source: string, selector: string): Record<string, string> {
  const text = stripComments(source);
  const found: Record<string, string> = {};
  const re = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`, 'gm');
  let matched = false;
  for (const match of text.matchAll(re)) {
    matched = true;
    let depth = 1;
    let index = match.index + match[0].length;
    const opening = index;
    while (depth > 0) {
      if (text[index] === '{') depth += 1;
      if (text[index] === '}') depth -= 1;
      index += 1;
    }
    for (const decl of text.slice(opening, index - 1).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      found[decl[1]] = decl[2].split(/\s+/).join(' ');
    }
  }
  assert.ok(matched, `no rule for ${selector}`);
  return found;
}

/** The token layer: everything down to the close of the `@theme inline` block. */
const TOKEN_LAYER = css.slice(0, css.indexOf('\n}\n', css.indexOf('@theme inline {')) + 3);
/** The rules. Nothing here may decide a colour, and nothing here may name a primitive. */
const RULES = css.slice(TOKEN_LAYER.length);

const light = declarations(TOKEN_LAYER, ':root');
const dark = declarations(TOKEN_LAYER, "[data-theme='dark']");
const theme = declarations(TOKEN_LAYER, '@theme inline');

/** A declaration that has to be there, so a missing token fails by name, not as `undefined`. */
function must(found: Record<string, string>, name: string, where: string): string {
  const value = found[name];
  assert.equal(typeof value, 'string', `${name} is not declared for ${where}`);
  return value as string;
}

/**
 * The brand's confirmed HEX values, transcribed from Console. Theme-independent by
 * construction: Blue 6 is Blue 6 under either theme, which is why none of them is repeated
 * in the dark block.
 */
const CONSOLE_PRIMITIVES: Record<string, string> = {
  '--rr-blue': '#2b52ff',
  '--rr-black': '#0a0b0c',
  '--rr-white': '#ffffff',
  '--rr-blue-1': '#eff4ff',
  '--rr-blue-2': '#d9e6ff',
  '--rr-blue-3': '#bad2ff',
  '--rr-blue-4': '#8aafff',
  '--rr-blue-5': '#507fff',
  '--rr-blue-6': '#2b52ff',
  '--rr-blue-7': '#1733d5',
  '--rr-blue-8': '#09209c',
  '--rr-blue-9': '#061460',
  '--rr-blue-10': '#030c34',
  '--rr-gray-1': '#f8f9fb',
  '--rr-gray-2': '#eff1f4',
  '--rr-gray-3': '#dfe2e8',
  '--rr-gray-4': '#cbcfd7',
  '--rr-gray-5': '#aab0bb',
  '--rr-gray-6': '#7c8390',
  '--rr-gray-7': '#576071',
  '--rr-gray-8': '#292e37',
  '--rr-gray-9': '#141719',
  '--rr-gradient-primary': 'linear-gradient(135deg, #f8f9fb 0%, #507fff 100%)',
  '--rr-teal-1': '#dcfffe',
  '--rr-teal-2': '#b9fffd',
  '--rr-teal-3': '#6ff4f0',
  '--rr-teal-4': '#00b5c2',
  '--rr-teal-5': '#006a7a',
  '--rr-sky-1': '#e4f0ff',
  '--rr-sky-2': '#bad9ff',
  '--rr-sky-3': '#2f8dff',
  '--rr-sky-4': '#0e51b6',
  '--rr-sky-5': '#002a68',
  '--rr-violet-1': '#f2e9ff',
  '--rr-violet-2': '#d4b3ff',
  '--rr-violet-3': '#8944ff',
  '--rr-violet-4': '#4500ac',
  '--rr-violet-5': '#140042',
  '--rr-pink-1': '#ffe3fc',
  '--rr-pink-2': '#ffb2f6',
  '--rr-pink-3': '#ff39ba',
  '--rr-pink-4': '#8a0061',
  '--rr-pink-5': '#380037',
  '--rr-red-1': '#ffe8e1',
  '--rr-red-2': '#ffc2ba',
  '--rr-red-3': '#ff5452',
  '--rr-red-4': '#a31310',
  '--rr-red-5': '#560100',
  '--rr-orange-1': '#ffedda',
  '--rr-orange-2': '#ffd5ab',
  '--rr-orange-3': '#ff9c1b',
  '--rr-orange-4': '#ae5100',
  '--rr-orange-5': '#5c2d00',
  '--rr-yellow-1': '#fff7cc',
  '--rr-yellow-2': '#ffed94',
  '--rr-yellow-3': '#ffda1e',
  '--rr-yellow-4': '#d2a100',
  '--rr-yellow-5': '#734f00',
  '--rr-lime-1': '#f2ffc3',
  '--rr-lime-2': '#e5ff81',
  '--rr-lime-3': '#cffd21',
  '--rr-lime-4': '#89ad00',
  '--rr-lime-5': '#2f5f00',
  '--rr-green-1': '#d6ffe1',
  '--rr-green-2': '#a6ffbf',
  '--rr-green-3': '#29e474',
  '--rr-green-4': '#00864a',
  '--rr-green-5': '#004829',
};

/**
 * Console's semantic roles as `[light, dark]`. Every value is a primitive or a mix of two,
 * because a literal here would be a place a colour is decided that is not the brand.
 *
 * Roles Console re-points for dark are written twice; roles it declares once carry the same
 * string in both slots, which is the assertion that Eval does not re-point them either.
 */
const CONSOLE_ROLES: Record<string, [string, string]> = {
  '--background': ['var(--rr-gray-1)', 'var(--rr-gray-9)'],
  '--background-secondary': ['var(--rr-gray-2)', 'var(--rr-black)'],
  '--card': ['var(--rr-white)', 'color-mix(in srgb, var(--rr-gray-8) 45%, var(--rr-gray-9))'],
  '--card-foreground': ['var(--rr-gray-9)', 'var(--rr-gray-1)'],
  '--popover': ['var(--rr-white)', 'color-mix(in srgb, var(--rr-gray-8) 45%, var(--rr-gray-9))'],
  '--popover-foreground': ['var(--rr-gray-9)', 'var(--rr-gray-1)'],
  '--foreground': ['var(--rr-gray-9)', 'var(--rr-gray-1)'],
  '--muted-foreground': ['var(--rr-gray-7)', 'var(--rr-gray-5)'],
  '--subtle-foreground': ['var(--rr-gray-6)', 'var(--rr-gray-6)'],
  '--disabled-foreground': ['var(--rr-gray-5)', 'var(--rr-gray-7)'],
  '--accent': ['var(--rr-gray-2)', 'color-mix(in srgb, var(--rr-gray-8) 45%, var(--rr-gray-9))'],
  '--accent-foreground': ['var(--rr-gray-9)', 'var(--rr-gray-1)'],
  '--accent-active': ['var(--rr-gray-3)', 'var(--rr-gray-8)'],
  '--secondary': ['var(--rr-gray-2)', 'var(--rr-gray-8)'],
  '--secondary-foreground': ['var(--rr-gray-9)', 'var(--rr-gray-1)'],
  '--muted': ['var(--rr-gray-2)', 'var(--rr-gray-8)'],
  '--primary': ['var(--rr-blue-6)', 'var(--rr-blue-5)'],
  '--primary-foreground': ['var(--rr-white)', 'var(--rr-black)'],
  '--primary-hover': ['var(--rr-blue-7)', 'var(--rr-blue-4)'],
  '--primary-muted': ['var(--rr-blue-3)', 'var(--rr-blue-9)'],
  '--primary-soft': ['var(--rr-blue-1)', 'var(--rr-blue-10)'],
  '--primary-ink': ['var(--rr-blue-6)', 'var(--rr-blue-4)'],
  '--border-subtle': [
    'var(--rr-gray-2)',
    'color-mix(in srgb, var(--rr-gray-8) 55%, var(--rr-gray-9))',
  ],
  '--border': ['var(--rr-gray-3)', 'var(--rr-gray-8)'],
  '--border-strong': ['var(--rr-gray-4)', 'var(--rr-gray-7)'],
  '--input': ['var(--rr-gray-6)', 'var(--rr-gray-6)'],
  '--ring': ['var(--rr-blue-6)', 'var(--rr-blue-5)'],
  '--success': ['var(--rr-green-4)', 'var(--rr-green-3)'],
  '--success-foreground': ['var(--rr-white)', 'var(--rr-black)'],
  '--success-soft': ['var(--rr-green-1)', 'var(--rr-green-5)'],
  '--success-ink': ['var(--rr-green-5)', 'var(--rr-green-3)'],
  '--warning': ['var(--rr-orange-4)', 'var(--rr-orange-3)'],
  '--warning-foreground': ['var(--rr-white)', 'var(--rr-black)'],
  '--warning-soft': ['var(--rr-orange-1)', 'var(--rr-orange-5)'],
  '--warning-ink': ['var(--rr-orange-4)', 'var(--rr-orange-3)'],
  '--destructive': ['var(--rr-red-4)', 'var(--rr-red-3)'],
  '--destructive-foreground': ['var(--rr-white)', 'var(--rr-black)'],
  '--destructive-soft': ['var(--rr-red-1)', 'var(--rr-red-5)'],
  '--destructive-ink': ['var(--rr-red-4)', 'var(--rr-red-3)'],
  '--overlay': [
    'color-mix(in srgb, var(--rr-black) 45%, transparent)',
    'color-mix(in srgb, var(--rr-black) 65%, transparent)',
  ],
  '--tooltip': ['var(--rr-gray-9)', 'var(--rr-black)'],
  '--tooltip-foreground': ['var(--rr-gray-1)', 'var(--rr-gray-1)'],
  '--sidebar': ['var(--rr-white)', 'var(--rr-black)'],
  '--sidebar-foreground': ['var(--rr-gray-9)', 'var(--rr-gray-1)'],
  '--sidebar-primary': ['var(--rr-blue-6)', 'var(--rr-blue-5)'],
  '--sidebar-primary-foreground': ['var(--rr-white)', 'var(--rr-black)'],
  '--sidebar-accent': ['var(--rr-gray-2)', 'var(--rr-gray-8)'],
  '--sidebar-accent-foreground': ['var(--rr-gray-9)', 'var(--rr-gray-1)'],
  '--sidebar-border': ['var(--rr-gray-3)', 'var(--rr-gray-8)'],
  '--sidebar-ring': ['var(--rr-blue-6)', 'var(--rr-blue-5)'],
  '--spectrum-teal': ['var(--rr-teal-5)', 'var(--rr-teal-3)'],
  '--spectrum-sky': ['var(--rr-sky-4)', 'var(--rr-sky-3)'],
  '--spectrum-violet': ['var(--rr-violet-4)', 'var(--rr-violet-3)'],
  '--spectrum-pink': ['var(--rr-pink-4)', 'var(--rr-pink-3)'],
  '--spectrum-red': ['var(--rr-red-4)', 'var(--rr-red-3)'],
  '--spectrum-orange': ['var(--rr-orange-4)', 'var(--rr-orange-3)'],
  '--spectrum-yellow': ['var(--rr-yellow-5)', 'var(--rr-yellow-3)'],
  '--spectrum-lime': ['var(--rr-lime-5)', 'var(--rr-lime-3)'],
  '--spectrum-green': ['var(--rr-green-4)', 'var(--rr-green-3)'],
  '--chart-1': ['var(--spectrum-sky)', 'var(--spectrum-sky)'],
  '--chart-2': ['var(--spectrum-pink)', 'var(--spectrum-pink)'],
  '--chart-3': ['var(--spectrum-lime)', 'var(--spectrum-lime)'],
  '--chart-4': ['var(--spectrum-orange)', 'var(--spectrum-orange)'],
  '--chart-5': ['var(--spectrum-violet)', 'var(--spectrum-violet)'],
  '--chart-6': ['var(--spectrum-teal)', 'var(--spectrum-teal)'],
  '--chart-7': ['var(--spectrum-yellow)', 'var(--spectrum-yellow)'],
  '--chart-8': ['var(--spectrum-green)', 'var(--spectrum-green)'],
  '--chart-cursor': [
    'color-mix(in srgb, var(--rr-gray-8) 8%, transparent)',
    'color-mix(in srgb, var(--rr-gray-1) 8%, transparent)',
  ],
  '--code-comment': ['var(--rr-gray-7)', 'var(--rr-gray-5)'],
  '--code-string': ['var(--rr-green-5)', 'var(--rr-green-3)'],
  '--code-number': ['var(--rr-orange-4)', 'var(--rr-orange-3)'],
  '--code-keyword': ['var(--rr-violet-4)', 'var(--rr-violet-2)'],
  '--code-literal': ['var(--rr-pink-4)', 'var(--rr-pink-2)'],
  '--code-property': ['var(--rr-sky-4)', 'var(--rr-sky-2)'],
  '--code-variable': ['var(--rr-teal-5)', 'var(--rr-teal-3)'],
  '--code-operator': ['var(--rr-gray-7)', 'var(--rr-gray-5)'],
  '--code-punctuation': ['var(--rr-gray-7)', 'var(--rr-gray-5)'],
  '--shadow-soft': [
    '0 1px 2px color-mix(in srgb, var(--rr-gray-8) 5%, transparent)',
    '0 1px 2px color-mix(in srgb, var(--rr-black) 30%, transparent)',
  ],
  '--shadow-card': [
    '0 1px 2px color-mix(in srgb, var(--rr-gray-8) 5%, transparent), ' +
      '0 4px 16px color-mix(in srgb, var(--rr-gray-8) 7%, transparent)',
    '0 1px 2px color-mix(in srgb, var(--rr-black) 25%, transparent), ' +
      '0 4px 16px color-mix(in srgb, var(--rr-black) 35%, transparent)',
  ],
  '--shadow-elevated': [
    '0 2px 4px color-mix(in srgb, var(--rr-gray-8) 6%, transparent), ' +
      '0 12px 32px color-mix(in srgb, var(--rr-gray-8) 12%, transparent)',
    '0 2px 4px color-mix(in srgb, var(--rr-black) 30%, transparent), ' +
      '0 12px 32px color-mix(in srgb, var(--rr-black) 50%, transparent)',
  ],
};

/** Console's type tokens. Same families, or the two products are not the same product. */
const CONSOLE_TYPE: Record<string, string> = {
  '--font-sans':
    '"Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, system-ui, ' +
    '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  '--font-display': 'var(--font-sans)',
  '--font-mono':
    '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", ' +
    'Menlo, Consolas, "Liberation Mono", monospace',
};

/**
 * Roles this app needs and Console does not name. Each is declared from primitives only and
 * commented where it is declared; the list is here so a role cannot appear in the stylesheet
 * without a line in this file admitting it is ours and not Console's.
 *
 *   --input-hover                             a control boundary under the cursor
 *   --success-line --warning-line
 *   --destructive-line                        the edge of a status strip, which Console's
 *                                             strips do not have
 *   --progress-start --progress-end           the two ends of the run bar, which is drawn on
 *                                             a surface that is dark in both themes
 *   --titlebar and its fourteen inks          a bar Console has no equivalent of
 *   --terminal-bg --terminal-cursor
 *   --terminal-scroll                         a terminal, likewise
 */
const NOT_IN_CONSOLE = [
  '--input-hover',
  '--success-line',
  '--warning-line',
  '--destructive-line',
  '--progress-start',
  '--progress-end',
  '--titlebar',
  '--titlebar-ink',
  '--titlebar-ink-strong',
  '--titlebar-ink-max',
  '--titlebar-muted',
  '--titlebar-muted-strong',
  '--titlebar-hover-ink',
  '--titlebar-accent',
  '--titlebar-accent-hover',
  '--titlebar-ok',
  '--titlebar-bad',
  '--titlebar-hairline',
  '--titlebar-hover',
  '--titlebar-divider',
  '--titlebar-active',
  '--titlebar-btn-line',
  '--titlebar-btn-hover',
  '--titlebar-btn-hover-line',
  '--terminal-bg',
  '--terminal-cursor',
  '--terminal-scroll',
];

/**
 * Band 3. The vocabulary the rules below already spell, as aliases onto band 2, and the one
 * place to look to answer "what is `--panel`". Listed here because the point of the band is
 * that it holds no values, and a test is the only thing that keeps it that way.
 */
const LOCAL_NAMES = [
  '--bg',
  '--panel',
  '--surface-sunken',
  '--surface-hover',
  '--line',
  '--line-strong',
  '--ink',
  '--miss',
  '--on-solid',
  '--brand',
  '--brand-hover',
  '--brand-deep',
  '--brand-tint',
  '--brand-tint-soft',
  '--ok',
  '--ok-tint',
  '--ok-line',
  '--ok-tint-soft',
  '--warn',
  '--warn-tint',
  '--warn-line',
  '--warn-line-soft',
  '--danger',
  '--danger-solid',
  '--danger-tint',
  '--danger-line',
  '--router-tint',
  '--ghost-line',
  '--ghost-line-hover',
  '--feasible',
  '--series-seed',
  '--series-neutral',
  '--chart-tick',
  '--chart-label',
  '--chart-faint',
  '--chart-grid',
  '--scrim',
  '--shadow-modal',
];

test("carries every brand primitive at Console's value", () => {
  for (const [name, value] of Object.entries(CONSOLE_PRIMITIVES)) {
    assert.equal(must(light, name, 'light'), value, `${name} drifted from Console`);
  }
  // Nothing extra: a primitive this app invented would be a brand colour nobody approved.
  const declared = Object.keys(light).filter((name) => name.startsWith('--rr-'));
  assert.deepEqual(declared.sort(), Object.keys(CONSOLE_PRIMITIVES).sort());
});

test('leaves the primitives theme-independent', () => {
  // Blue 6 is Blue 6 in light and in dark. Re-pointing one for a theme would mean the brand
  // has two blues, and every role that reads it would move without saying so.
  assert.deepEqual(
    Object.keys(dark).filter((name) => name.startsWith('--rr-')),
    [],
  );
});

test('points every semantic role where Console points it, in both themes', () => {
  for (const [role, [expectLight, expectDark]] of Object.entries(CONSOLE_ROLES)) {
    assert.equal(must(light, role, 'light'), expectLight, `${role}, light`);
    // A role Console leaves alone in dark is one this app leaves alone too, so its dark value
    // is the light one falling through.
    assert.equal(dark[role] ?? light[role], expectDark, `${role}, dark`);
  }
});

test('re-points in dark exactly the roles Console re-points', () => {
  /**
   * Console restates a handful of roles in its dark block at the value they already hold, and
   * each of those restatements carries a contrast note explaining why the step does not move
   * (`--input` and `--subtle-foreground` are the same grey in both themes on purpose). So the
   * assertion is set equality, not "no redundant twin": a role missing from this block would
   * fall through to a light value on a dark page, and a role added to it would be a value
   * decided here that Console decides elsewhere.
   *
   * The four extras are the roles Console does not have, and all four need a dark step: a
   * status strip's edge and a control boundary's hover both move with the theme.
   */
  const consoleDarkKeys = Object.entries(CONSOLE_ROLES)
    .filter(([role]) => role in dark)
    .map(([role]) => role);
  assert.equal(consoleDarkKeys.length, 72, "Console re-points 72 roles for dark");
  assert.deepEqual(Object.keys(dark).sort(), [
    ...consoleDarkKeys,
    '--destructive-line',
    '--input-hover',
    '--success-line',
    '--warning-line',
  ].sort());
});

test('decides no colour outside the primitive band', () => {
  // Everything after the primitives is `var()` or a mix of `var()`s. A literal below that
  // point is a second place a colour is decided, and the two will drift.
  const primitives = stripComments(TOKEN_LAYER);
  const opening = primitives.indexOf('{', primitives.indexOf(':root'));
  let depth = 1;
  let index = opening + 1;
  while (depth > 0) {
    if (primitives[index] === '{') depth += 1;
    if (primitives[index] === '}') depth -= 1;
    index += 1;
  }
  const literals = primitives.slice(index).match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g) ?? [];
  assert.deepEqual(literals, [], `literal colours in the semantic and local bands: ${literals}`);
});

test('accounts for every role Console has, and every role it does not', () => {
  const roles = Object.keys(light).filter((name) => !name.startsWith('--rr-'));
  const expected = [...Object.keys(CONSOLE_ROLES), ...NOT_IN_CONSOLE, ...LOCAL_NAMES].sort();
  // Three ways in and no fourth: a role Console decides, a role this app decides and admits
  // to, or a local name that decides nothing. Anything else fails here by name.
  assert.deepEqual(roles.sort(), expected);
  // Console's full role set, so a role added there cannot be quietly skipped here.
  assert.equal(Object.keys(CONSOLE_ROLES).length, 80);
  assert.equal(new Set(expected).size, expected.length, 'a name is listed twice');
});

test('keeps the local vocabulary as aliases and nothing more', () => {
  for (const name of LOCAL_NAMES) {
    const value = must(light, name, 'light');
    assert.match(
      value,
      /^(var\(--[\w-]+\)|color-mix\(in srgb, var\(--[\w-]+\) [\d.]+%, transparent\))$/,
      `${name} is not a plain alias, so it is a second place a colour is decided`,
    );
    // The role it names is already re-pointed for dark, so a twin here would be a second
    // place the dark palette is decided. Deleting those twins is most of what this change is.
    assert.ok(!(name in dark), `${name} has a dark twin, which the semantic layer makes dead`);
  }
});

test('lets no rule name a brand primitive', () => {
  // The rules speak band 2 and band 3. Reaching past them to `--rr-blue-6` is how a screen
  // ends up with a colour that cannot follow the theme.
  const named = [...new Set(RULES.match(/var\(--rr-[\w-]+\)/g) ?? [])];
  assert.deepEqual(named, [], `rules naming a primitive: ${named.join(', ')}`);
  for (const file of sources()) {
    const named = [...new Set(readFileSync(file, 'utf8').match(/--rr-[\w-]+/g) ?? [])];
    assert.deepEqual(named, [], `${file} names a primitive: ${named.join(', ')}`);
  }
});

test('hardcodes no colour in any component', () => {
  /**
   * `DeployTerminal` is the one exception and the reason it is one: xterm paints to a canvas,
   * which cannot resolve `var()`, so the component reads the two terminal tokens through
   * `getComputedStyle` and needs a literal for the case where that returns nothing. Both
   * literals have to be the brand value the token holds, or the fallback path paints
   * off-brand and nobody notices until it fires.
   */
  const allowed = new Map([
    [join(SRC, 'components', 'DeployTerminal.tsx'), ['#0a0b0c', '#8aafff']],
  ]);
  for (const file of sources()) {
    const found = readFileSync(file, 'utf8').match(/#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b/g) ?? [];
    assert.deepEqual(found, allowed.get(file) ?? [], `hardcoded colours in ${file}`);
  }
  assert.equal(must(light, '--terminal-bg', 'light'), 'var(--rr-black)');
  assert.equal(CONSOLE_PRIMITIVES['--rr-black'], '#0a0b0c');
  assert.equal(must(light, '--terminal-cursor', 'light'), 'var(--rr-blue-4)');
  assert.equal(CONSOLE_PRIMITIVES['--rr-blue-4'], '#8aafff');
});

test('names Pretendard first, and the same stack Console names', () => {
  for (const [name, value] of Object.entries(CONSOLE_TYPE)) {
    assert.equal(must(theme, name, '@theme inline'), value, `${name} drifted from Console`);
  }
  // Pretendard carries Latin and Hangul in one face, so Korean is not a fallback here: it is
  // the same font, and it has to be asked for first or the system face wins the race.
  assert.ok(must(theme, '--font-sans', '@theme inline').startsWith('"Pretendard Variable", Pretendard,'));
  // One declaration of the stack. It used to be copied literally into five rules, which is
  // five places a family could be changed and four of them would be missed.
  assert.equal(css.split('Pretendard Variable').length - 1, 2, 'the stack is written twice');
});

test('pins Pretendard once, to the build the other products load', () => {
  const pins = layout.match(/pretendard@[\w.]+/g) ?? [];
  assert.deepEqual(pins, ['pretendard@v1.3.9'], 'the version is named more than once, or not at all');
  // The variable dynamic subset: the whole weight axis, split into slices the browser fetches
  // only for glyphs a page actually renders. Console loads the same file.
  assert.match(layout, /variable\/pretendardvariable-dynamic-subset\.min\.css/);
  assert.match(layout, /rel="preconnect" href="https:\/\/cdn\.jsdelivr\.net"/);
});

test('keeps the monospace stack a code font', () => {
  /**
   * Code surfaces only: token values, ids, machine paths, streamed log output. Never a UI
   * label and never body copy. Listed rather than counted, so adding a mono surface is a
   * decision somebody writes down.
   */
  const CODE_SURFACES = [
    'code',
    '.mono',
    '.evolve-chart-tip-id',
    '.deploy-hf-input',
    '.settings-input',
    '.gen-template-id',
    '.cmp-legend-key',
    '.cmp-log',
  ];
  const users: string[] = [];
  for (const rule of stripComments(RULES).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (rule[2].includes('var(--font-mono)')) users.push(rule[1].split(/\s+/).join(' ').trim());
  }
  assert.deepEqual(users.sort(), [...CODE_SURFACES].sort());
});

test("does not take Console's type size scale, and says so", () => {
  // The requirement is not that the scale is absent; it is that the reason is written down,
  // because a later change that takes it has to take it everywhere at once or every screen
  // re-flows a little.
  assert.match(TOKEN_LAYER, /type size, leading and tracking scale/);
  const scale = Object.keys(light).filter((name) => /^--(text|font-size|leading|tracking)-/.test(name));
  assert.deepEqual(scale, [], 'half a type scale is worse than none');
});

test('writes no em dash in the token layer', () => {
  // Never an em dash in this product, and the file the brand lives in is no exception.
  assert.equal(TOKEN_LAYER.includes('\u2014'), false);
});

/** Every source file under `apps/web/src`, so a new panel is covered the day it is written. */
function sources(): string[] {
  const walk = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    });
  return walk(SRC).filter((path) => /\.(tsx?|mts)$/.test(path));
}
