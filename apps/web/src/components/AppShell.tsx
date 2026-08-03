'use client';

import Link from 'next/link';
import { MODULES, type ModuleId } from '@/lib/modules';

export function ModuleNav({ current }: { current: ModuleId }) {
  return (
    <nav className="mode-switch" aria-label="Modules">
      <Link href="/" className={current === 'home' ? 'on' : undefined} aria-current={current === 'home' ? 'page' : undefined}>
        Home
      </Link>
      {MODULES.filter((m) => m.nav).map((m) => (
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
 */
export function AppShell({ module, port = 3939, center, right, children }: ShellProps) {
  const mod = MODULES.find((m) => m.id === module);
  return (
    <div className="app">
      <header className="app-titlebar">
        <div className="app-titlebar-left">
          <Link href="/" className="app-name">
            redrob-eval
          </Link>
          <span className="app-sep" />
          <span className="app-muted">:{port}</span>
          {mod && module !== 'home' ? (
            <>
              <span className="app-sep" />
              <span className="app-muted">{mod.label}</span>
            </>
          ) : null}
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
