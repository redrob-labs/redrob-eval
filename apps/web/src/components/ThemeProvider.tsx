'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';

import {
  applyTheme,
  readStoredTheme,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type Theme,
} from '@/lib/theme';

interface ThemeContextValue {
  /** What the user picked, which may be `system`. */
  theme: Theme;
  /** What is actually on screen. */
  resolved: ResolvedTheme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** `storage` only fires in *other* tabs, so same-tab changes need their own signal. */
const THEME_EVENT = 'redrob-theme-change';

/**
 * Set only when `localStorage` refused the write, which private browsing and blocked
 * third-party storage both do. Without it a blocked write leaves every read returning
 * the default and the switch looks broken rather than merely forgetful.
 */
let unstoredTheme: Theme | null = null;

function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', onChange);
  window.addEventListener('storage', onChange);
  window.addEventListener(THEME_EVENT, onChange);
  return () => {
    media.removeEventListener('change', onChange);
    window.removeEventListener('storage', onChange);
    window.removeEventListener(THEME_EVENT, onChange);
  };
}

/**
 * A string rather than an object, because `useSyncExternalStore` compares snapshots by
 * identity and a fresh object every call is an infinite render loop.
 */
function getSnapshot(): string {
  const theme = unstoredTheme ?? readStoredTheme();
  return `${theme}|${resolveTheme(theme)}`;
}

function getServerSnapshot(): string {
  // The server cannot know either half. It renders no colour-dependent markup, and the
  // inline script has already set the real theme on <html> by the time this hydrates.
  return 'system|light';
}

/**
 * Holds the theme choice and keeps <html> in step with it.
 *
 * The choice lives in two places the React tree does not own -- `localStorage` and the
 * OS setting -- so it is read with `useSyncExternalStore` rather than mirrored into
 * state. Mirroring would mean an effect that writes state on mount, which is both a
 * cascading render and a second copy of the truth that can go stale when another tab
 * changes it.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [theme, resolved] = snapshot.split('|') as [Theme, ResolvedTheme];

  useEffect(() => {
    // Updating an external system, which is what effects are for. Usually a no-op: the
    // inline script got here first. It earns its place when the OS flips while `system`
    // is selected, and when another tab changes the preference.
    applyTheme(resolved);
  }, [resolved]);

  const setTheme = useCallback((next: Theme) => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
      unstoredTheme = null;
    } catch {
      // Blocked storage costs persistence across reloads, not the switch itself.
      unstoredTheme = next;
    }
    window.dispatchEvent(new Event(THEME_EVENT));
  }, []);

  const value = useMemo(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside a ThemeProvider');
  return value;
}
