'use client';

import Link from 'next/link';
import { MODULES, type ModuleId } from '@/lib/modules';
import { useT } from '@/components/LocaleProvider';
import { RedrobLogo } from '@/components/RedrobLogo';
import { ThemeToggle } from '@/components/ThemeSwitch';
import type { MessageKey } from '@/lib/i18n';

const MODULE_LABEL_KEYS: Record<Exclude<ModuleId, 'settings'>, MessageKey> = {
  compare: 'nav.compare',
  evolve: 'nav.evolve',
  deploy: 'nav.deploy',
  generate: 'nav.generate',
  analyze: 'nav.analyze',
};

export function ModuleNav({ current }: { current: ModuleId }) {
  const t = useT();
  return (
    <nav className="mode-switch" aria-label={t('nav.modulesAria')}>
      {MODULES.map((m) => (
        <Link
          key={m.id}
          href={m.href}
          className={current === m.id ? 'on' : undefined}
          aria-current={current === m.id ? 'page' : undefined}
        >
          {t(MODULE_LABEL_KEYS[m.id])}
        </Link>
      ))}
    </nav>
  );
}

type ShellProps = {
  module: ModuleId;
  port?: number;
  /** Center titlebar (progress / status) */
  center?: React.ReactNode;
  /** Right titlebar actions */
  right?: React.ReactNode;
  children: React.ReactNode;
};

/**
 * Shared chrome for every modality page — modules are routes, not tabs.
 * Port stays in the brand tooltip only (local workbench hint, not chrome noise).
 */
export function AppShell({ module, port = 3939, center, right, children }: ShellProps) {
  const t = useT();
  return (
    <div className="app">
      <header className="app-titlebar">
        <div className="app-titlebar-left">
          <Link
            href="/"
            className="app-name"
            title={t('nav.homeTitle', { port })}
          >
            <RedrobLogo size={16} className="app-logo" />
            <span>{t('nav.home')}</span>
          </Link>
          <span className="app-sep" aria-hidden />
          <ModuleNav current={module} />
        </div>
        <div className="app-titlebar-center" aria-live="polite">
          {center}
        </div>
        <div className="app-titlebar-right">
          {right}
          <ThemeToggle />
          <Link
            href="/settings"
            className={`app-settings-link${module === 'settings' ? ' on' : ''}`}
            aria-current={module === 'settings' ? 'page' : undefined}
          >
            {t('nav.settings')}
          </Link>
        </div>
      </header>
      {children}
    </div>
  );
}
