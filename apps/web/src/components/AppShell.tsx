'use client';

import Link from 'next/link';
import { MODULES, type ModuleId } from '@/lib/modules';

export function ModuleNav({ current }: { current: ModuleId }) {
  return (
    <nav className="mode-switch" aria-label="Modules">
      {MODULES.filter((m) => m.nav).map((m) => (
        <Link
          key={m.id}
          href={m.href}
          className={current === m.id ? 'on' : undefined}
          aria-current={current === m.id ? 'page' : undefined}
          title={m.badge ? `${m.label} (${m.badge})` : m.label}
        >
          {m.label}
          {m.badge ? <span className="mode-switch-badge">{m.badge}</span> : null}
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
 */
export function AppShell({ module, port = 3939, center, right, children }: ShellProps) {
  return (
    <div className="app">
      <header className="app-titlebar">
        <div className="app-titlebar-left">
          <Link href="/" className="app-name" title="Home">
            redrob-eval
          </Link>
          <span className="app-sep" />
          <span className="app-muted">:{port}</span>
          <ModuleNav current={module} />
        </div>
        <div className="app-titlebar-center" aria-live="polite">
          {center}
        </div>
        <div className="app-titlebar-right">{right}</div>
      </header>
      {children}
    </div>
  );
}
