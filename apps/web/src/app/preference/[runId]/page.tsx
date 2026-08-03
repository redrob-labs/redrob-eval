'use client';

import Link from 'next/link';
import { use } from 'react';
import { AppShell } from '@/components/AppShell';
import { PreferenceRunDetail } from '@/components/PreferenceRunDetail';

export default function PreferenceRunPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId: raw } = use(params);
  const runId = decodeURIComponent(raw);

  return (
    <AppShell
      module="preference"
      right={
        <Link href="/preference" className="app-ghost-btn">
          Back to Preference
        </Link>
      }
    >
      <main className="pref-page pref-detail-page">
        <div className="pref-page-head">
          <div className="pref-page-title-row">
            <h1>Preference run</h1>
            <span className="pref-preview-badge">Stage 1</span>
          </div>
          <p className="pref-page-lede">
            Generation matrix for this run. Live progress streams until the job finishes.
          </p>
        </div>
        <section className="pref-card pref-detail-card">
          <PreferenceRunDetail runId={runId} layout="page" />
        </section>
      </main>
    </AppShell>
  );
}
