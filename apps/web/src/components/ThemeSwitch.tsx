'use client';

import { useTheme } from '@/components/ThemeProvider';
import { THEMES, type Theme } from '@/lib/theme';

const LABELS: Record<Theme, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

function Icon({ theme }: { theme: Theme }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  if (theme === 'light') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  }
  if (theme === 'dark') {
    return (
      <svg {...common}>
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

/**
 * The three-way choice, spelled out.
 *
 * Three radios rather than a two-state toggle because "follow the OS" is a distinct
 * answer from either fixed value, and a checkbox cannot say it. A toggle would also have
 * to invent a position for the case where the OS is dark and the user never chose.
 */
export function ThemeSwitch() {
  const { theme, resolved, setTheme } = useTheme();

  return (
    <div className="theme-switch">
      <div className="theme-switch-options" role="radiogroup" aria-label="Colour theme">
        {THEMES.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={theme === option}
            className={`theme-switch-option${theme === option ? ' on' : ''}`}
            onClick={() => setTheme(option)}
          >
            <Icon theme={option} />
            {LABELS[option]}
          </button>
        ))}
      </div>
      {theme === 'system' ? (
        <p className="theme-switch-note">
          Following your operating system, which is currently {resolved}.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The titlebar control: one button that cycles System, Light, Dark.
 *
 * A cycle rather than three buttons because the titlebar is 48px tall and shared with
 * every module's own controls. The full choice stays in Settings; this is the shortcut
 * for the person who just walked into a dark room.
 */
export function ThemeToggle() {
  const { theme, resolved, setTheme } = useTheme();
  const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];

  return (
    <button
      type="button"
      className="app-theme-toggle"
      onClick={() => setTheme(next)}
      title={`Theme: ${LABELS[theme]}${theme === 'system' ? ` (${resolved})` : ''} — click for ${LABELS[next]}`}
      aria-label={`Colour theme: ${LABELS[theme]}. Switch to ${LABELS[next]}.`}
    >
      <Icon theme={theme} />
    </button>
  );
}
