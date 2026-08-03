'use client';

import { Suspense } from 'react';
import { ComparePanel } from '@/components/ComparePanel';
import { AppShell } from '@/components/AppShell';

export default function ComparePage() {
  return (
    <AppShell module="compare">
      <Suspense fallback={<main className="compare-panel p-4 text-sm text-slate-500">Loading Compare…</main>}>
        <ComparePanel />
      </Suspense>
    </AppShell>
  );
}
