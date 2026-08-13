'use client';

import { useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { useT } from '@/components/LocaleProvider';
import { RunDetail } from './RunDetail';
import { RunsList } from './RunsList';

/**
 * The analysis workspace.
 *
 * Everything the CLI tools surface - the registry, failure triage, the paired
 * comparison - on one screen: browse runs, open one, see why it failed and
 * whether a difference between models is real. Read-mostly; the only writes are
 * a saved cohort and a hand correction, both of which the CLI can also make.
 */
export function AnalyzeApp(props: { initialRunId?: string | null }) {
  const t = useT();
  const [runId, setRunId] = useState<string | null>(props.initialRunId ?? null);

  return (
    <AppShell module="analyze">
      <main className="cmp-page az-page">
        {runId ? (
          <RunDetail runId={runId} onBack={() => setRunId(null)} />
        ) : (
          <>
            <section className="cmp-card az-intro">
              <div className="pane-label">{t('analyze.title')}</div>
              <p className="field-hint">{t('analyze.subtitle')}</p>
            </section>
            <RunsList onOpen={setRunId} />
          </>
        )}
      </main>
    </AppShell>
  );
}
