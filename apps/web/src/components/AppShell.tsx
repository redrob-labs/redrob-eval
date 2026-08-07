'use client';

import Link from 'next/link';
import { MODULES, type ModuleId } from '@/lib/modules';
import { RedrobLogo } from '@/components/RedrobLogo';

export function ModuleNav({ current }: { current: ModuleId }) {
  return (
    <nav className="mode-switch" aria-label="Modules">
      {MODULES.map((m) => (
        <Link
          key={m.id}
          href={m.href}
          className={current === m.id ? 'on' : undefined}
          aria-current={current === m.id ? 'page' : undefined}
        >
          {m.label}
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
  return (
    <div className="app">
      <header className="app-titlebar">
        <div className="app-titlebar-left">
          <Link
            href="/"
            className="app-name"
            title={`Home · localhost:${port}`}
          >
            <RedrobLogo size={16} className="app-logo" />
            <span>redrob-eval</span>
          </Link>
          <span className="app-sep" aria-hidden />
          <ModuleNav current={module} />
        </div>
        <div className="app-titlebar-center" aria-live="polite">
          {center}
        </div>
        <div className="app-titlebar-right">
          {right}
          <Link
            href="/settings"
            className={`app-settings-link${module === 'settings' ? ' on' : ''}`}
            aria-current={module === 'settings' ? 'page' : undefined}
          >
            Settings
          </Link>
        </div>
      </header>
      {children}
    </div>
  );
}
