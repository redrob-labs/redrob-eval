'use client';

import { ComparePanel } from '@/components/ComparePanel';
import { AppShell } from '@/components/AppShell';

export default function ComparePage() {
  return (
    <AppShell module="compare">
      <ComparePanel />
    </AppShell>
  );
}
