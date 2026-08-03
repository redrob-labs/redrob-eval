'use client';

import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { MODULES } from '@/lib/modules';

export default function HomePage() {
  return (
    <AppShell module="home">
      <main className="module-hub">
        <div className="module-hub-intro">
          <h1 className="font-[family-name:var(--font-display)] text-2xl font-bold text-slate-900">
            redrob-eval
          </h1>
          <p className="mt-2 max-w-xl text-sm text-slate-600">
            Each modality is its own page. Pick a module — costs stay relative percentages of a
            baseline; provider keys stay in server <code>.env</code>.
          </p>
        </div>
        <ul className="module-hub-grid">
          {MODULES.map((m) => (
            <li key={m.id}>
              <Link href={m.href} className="module-hub-card">
                <strong>{m.label}</strong>
                <span>{m.blurb}</span>
              </Link>
            </li>
          ))}
        </ul>
      </main>
    </AppShell>
  );
}
