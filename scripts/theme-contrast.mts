/**
 * Resolving theme tokens out of globals.css, and WCAG contrast between them.
 *
 * Shared by the test (`scripts/test/theme-contrast.test.mts`) and the report
 * (`apps/web/scripts/check-theme-contrast.mjs`) so there is one implementation of what
 * a pairing is and what it has to clear.
 */

/** A colour as `[r, g, b, alpha]`, alpha in 0..1. */
export type Rgba = [number, number, number, number];

export type Tokens = Record<string, string>;

export type Kind = 'text' | 'large' | 'ui' | 'surface';

/** `[foreground, background, kind, backdrop?]`. */
export type Pair = [string, string, Kind] | [string, string, Kind, string];

/** Every `--name: value;` inside the blocks matching `selector`. */
export function readBlocks(css: string, selector: string): Tokens {
  const tokens: Tokens = {};
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `^` with the m flag: the selector must start a line, so `:root` does not also match
  // the `:root` inside a longer selector.
  const re = new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'gm');
  const matches = [...css.matchAll(re)];
  if (matches.length === 0) throw new Error(`no block matched selector ${selector}`);
  for (const match of matches) {
    for (const decl of match[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      tokens[decl[1]] = decl[2].trim();
    }
  }
  return tokens;
}

function parseHex(hex: string): Rgba {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return [r, g, b, 1];
}

/** Lay a possibly-translucent colour over an opaque one. */
export function over([r, g, b, a]: Rgba, base: Rgba): Rgba {
  if (a >= 1) return [r, g, b, 1];
  const mixed = [r, g, b].map((c, i) => c * a + base[i] * (1 - a));
  return [mixed[0], mixed[1], mixed[2], 1];
}

/** Resolve a token to RGBA, following `var()` and evaluating `color-mix(in srgb, ...)`. */
export function resolve(value: string, tokens: Tokens, depth = 0): Rgba {
  if (depth > 12) throw new Error(`cycle resolving ${value}`);
  const v = value.trim();

  if (v.startsWith('#')) return parseHex(v);

  const rgba = v.match(/^rgba?\(([^)]+)\)$/);
  if (rgba) {
    const parts = rgba[1].split(',').map((p) => parseFloat(p.trim()));
    return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
  }

  const varMatch = v.match(/^var\((--[\w-]+)(?:,\s*(.+))?\)$/);
  if (varMatch) {
    const target = tokens[varMatch[1]] ?? varMatch[2];
    if (!target) throw new Error(`undefined token ${varMatch[1]}`);
    return resolve(target, tokens, depth + 1);
  }

  const mix = v.match(/^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*(.+)\)$/);
  if (mix) {
    const a = resolve(mix[1], tokens, depth + 1);
    const b = resolve(mix[3], tokens, depth + 1);
    const p = parseFloat(mix[2]) / 100;
    const mixed = [0, 1, 2].map((i) => a[i] * p + b[i] * (1 - p));
    return [mixed[0], mixed[1], mixed[2], 1];
  }

  throw new Error(`cannot resolve ${v}`);
}

function luminance([r, g, b]: Rgba): number {
  const lin = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

export function contrast(fg: Rgba, bg: Rgba): number {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

/**
 * `backdrop` is what a translucent foreground sits on, when that is not the background it
 * is being compared against -- the titlebar's bottom border is drawn on the bar and read
 * against the page below it.
 */
export function ratioFor(fg: string, bg: string, tokens: Tokens, backdrop?: string): number {
  const panel = resolve('var(--panel)', tokens);
  const behind = over(resolve(`var(${bg})`, tokens), panel);
  const under = backdrop ? over(resolve(`var(${backdrop})`, tokens), panel) : behind;
  return contrast(over(resolve(`var(${fg})`, tokens), under), behind);
}

/**
 * `text` needs 4.5:1 and `ui` needs 3:1, per WCAG 1.4.3 and 1.4.11.
 *
 * `surface` is the boundary between two adjacent flat areas -- panel against page,
 * titlebar against page, a hairline rule. WCAG 1.4.11 governs controls and meaningful
 * graphics, not decorative surface joins, and holding these to 3:1 would demand a light
 * theme whose cards are outlined in mid-grey. What it asks instead is that the step be
 * perceptible. Everything drawn *inside* the titlebar is checked as text and clears
 * 4.5:1 comfortably.
 */
export const MINIMUM: Record<Kind, number> = { text: 4.5, large: 3, ui: 3, surface: 1.25 };

export const PAIRS: Pair[] = [
  ['--ink', '--bg', 'text'],
  ['--ink', '--panel', 'text'],
  ['--ink', '--surface-sunken', 'text'],
  ['--ink', '--surface-hover', 'text'],
  ['--muted', '--panel', 'text'],
  ['--muted', '--bg', 'text'],
  ['--muted', '--surface-sunken', 'text'],
  ['--brand', '--panel', 'text'],
  ['--brand', '--bg', 'text'],
  ['--brand-deep', '--panel', 'text'],
  ['--brand-ink', '--brand-tint', 'text'],
  ['--ok', '--panel', 'text'],
  ['--ok', '--ok-tint', 'text'],
  ['--warn', '--panel', 'text'],
  ['--warn', '--warn-tint', 'text'],
  ['--danger', '--panel', 'text'],
  ['--danger', '--danger-tint', 'text'],
  ['--on-solid', '--brand-solid', 'text'],
  ['--on-solid', '--brand-solid-hover', 'text'],
  ['--on-solid', '--danger-solid', 'text'],
  ['--ink', '--warn-tint', 'text'],
  ['--ink', '--danger-tint', 'text'],
  ['--ink', '--ok-tint', 'text'],
  ['--ink', '--accent-tint', 'text'],
  ['--ink', '--brand-tint', 'text'],

  ['--titlebar-ink', '--titlebar', 'text'],
  ['--titlebar-ink-strong', '--titlebar', 'text'],
  ['--titlebar-muted', '--titlebar', 'text'],
  ['--titlebar-muted-strong', '--titlebar', 'text'],
  ['--titlebar-hover-ink', '--titlebar', 'text'],
  ['--titlebar-accent', '--titlebar', 'text'],
  ['--titlebar-ok', '--titlebar', 'text'],
  ['--titlebar-bad', '--titlebar', 'text'],

  ['--chart-tick', '--panel', 'ui'],
  ['--chart-axis', '--panel', 'ui'],
  ['--chart-label', '--panel', 'text'],
  ['--chart-faint', '--panel', 'ui'],
  ['--series-neutral', '--panel', 'ui'],
  ['--series-seed', '--panel', 'ui'],
  ['--feasible', '--panel', 'ui'],
  ['--brand', '--panel', 'ui'],
  ['--miss', '--panel', 'ui'],

  ['--line', '--panel', 'surface'],
  ['--line-strong', '--panel', 'surface'],
  ['--brand-solid', '--panel', 'ui'],
  ['--panel', '--bg', 'surface'],
  ['--titlebar', '--bg', 'surface'],
  // The edge under the titlebar, composited onto the bar it is drawn on.
  ['--titlebar-hairline', '--bg', 'surface', '--titlebar'],
];
