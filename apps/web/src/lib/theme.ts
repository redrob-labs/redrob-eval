/**
 * Light, dark, or follow the OS.
 *
 * `Theme` is what the user chose and `ResolvedTheme` is what is on screen; they differ
 * whenever the choice is `system`. Keeping them apart matters because the switch has to
 * keep showing "System" after the OS flips to dark, rather than silently rewriting the
 * preference to whatever the OS happened to be at the time.
 */
export type Theme = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEMES: Theme[] = ['system', 'light', 'dark'];

/** Read by the inline pre-paint script too, so it is a literal in two places. */
export const THEME_STORAGE_KEY = 'redrob-theme';

export function isTheme(value: unknown): value is Theme {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function systemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  return theme === 'system' ? systemTheme() : theme;
}

export function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'system';
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : 'system';
  } catch {
    // Private mode and blocked storage both throw here. Following the OS is the right
    // answer when the preference cannot be read, and it is also the default.
    return 'system';
  }
}

/**
 * Put the resolved theme on <html>.
 *
 * Always a concrete `light` or `dark`, never `system`. The stylesheet therefore needs
 * one `[data-theme='dark']` block rather than that block plus a duplicate inside a
 * `prefers-color-scheme` query, and the two can never drift apart.
 */
export function applyTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.dataset.theme = resolved;
  // Native widgets -- scrollbars, date pickers, form controls -- follow this, not CSS.
  root.style.colorScheme = resolved;
}

/**
 * The script that runs before first paint.
 *
 * Inlined into <head> and deliberately dependency-free: it runs before React, before
 * hydration, before the bundle. Anything it needed to import would be a network round
 * trip during which the page is the wrong colour.
 *
 * A dark-mode user loading a page that paints white first and corrects itself afterwards
 * is the single most visible defect a theme can have, and it cannot be fixed from a
 * `useEffect`, which by definition runs after paint.
 */
export const THEME_SCRIPT = `(function(){try{
var s=localStorage.getItem('${THEME_STORAGE_KEY}');
var t=(s==='light'||s==='dark')?s:(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');
document.documentElement.dataset.theme=t;
document.documentElement.style.colorScheme=t;
}catch(e){
document.documentElement.dataset.theme='light';
}})();`;
