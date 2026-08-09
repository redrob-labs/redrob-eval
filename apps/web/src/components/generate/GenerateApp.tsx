'use client';

import { useEffect, useState } from 'react';

import { AppShell } from '@/components/AppShell';

import { StudyStage } from './StudyStage';
import { TemplatesStage } from './TemplatesStage';
import {
  STAGE_LABELS,
  STAGE_ORDER,
  type CatalogTemplate,
  type GenerateStage,
  type GenerateStatus,
  type StudyConfigSummary,
} from './types';

/**
 * Generate makes the items the other modules are run on: parametric task families that
 * are sampled fresh from a content-derived seed, so a model cannot have memorised the
 * answer. Templates shows what exists and what one instance looks like; Study runs the
 * whole cross-locale design and reports the numbers.
 *
 * Sampling happens in Python and only in Python — this runtime reads and verifies but
 * does not generate — so the page asks once whether the CLI is reachable and says so
 * plainly rather than failing one button at a time.
 */
export function GenerateApp() {
  const [stage, setStage] = useState<GenerateStage>('templates');
  const [status, setStatus] = useState<GenerateStatus | null>(null);
  const [templates, setTemplates] = useState<CatalogTemplate[]>([]);
  const [studies, setStudies] = useState<StudyConfigSummary[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/generate/templates');
        const body = (await res.json()) as {
          templates?: CatalogTemplate[];
          studies?: StudyConfigSummary[];
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok) throw new Error(body.error ?? `catalog request failed (${res.status})`);
        setTemplates(body.templates ?? []);
        setStudies(body.studies ?? []);
        setCatalogError(null);
      } catch (error) {
        if (cancelled) return;
        setCatalogError(error instanceof Error ? error.message : 'could not read the catalog');
      }
    })();
    void (async () => {
      try {
        const res = await fetch('/api/generate/status');
        if (res.ok && !cancelled) setStatus((await res.json()) as GenerateStatus);
      } catch {
        // Leaving status null renders the banner as "checking", which is accurate:
        // nothing is known about the CLI, as opposed to knowing it is absent.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const pythonMissing = status !== null && !status.python.available;

  return (
    <AppShell
      module="generate"
      center={
        <nav className="cmp-stages" aria-label="Generate stages">
          {STAGE_ORDER.map((s, i) => (
            <button
              key={s}
              type="button"
              className={`cmp-stage${stage === s ? ' on' : ''}`}
              onClick={() => setStage(s)}
            >
              <span className="cmp-stage-n">{i + 1}</span>
              {STAGE_LABELS[s]}
            </button>
          ))}
        </nav>
      }
      right={
        status ? (
          <span
            className={`gen-runtime${status.python.available ? '' : ' off'}`}
            title={
              status.python.available
                ? `${status.python.version} is on PATH`
                : status.python.reason
            }
          >
            {status.python.available ? `redrob-generate ${status.python.version}` : 'CLI missing'}
          </span>
        ) : null
      }
    >
      <main className="cmp-page">
        {pythonMissing && !status.python.available ? (
          <section className="cmp-card gen-notice">
            <div className="pane-label">Generation is not installed</div>
            <p>{status.python.reason}</p>
            <p className="gen-notice-detail">
              The catalog below is read from disk and works without it. Sampling an
              instance and running a study both need the CLI, because generation is
              deliberately implemented once, in Python, and this runtime only reads and
              verifies what it produces.
            </p>
            <code className="gen-code">pip install -e packages/generate</code>
          </section>
        ) : null}

        {catalogError ? (
          <section className="cmp-card gen-notice gen-notice-error">
            <div className="pane-label">Could not read the template catalog</div>
            <p>{catalogError}</p>
          </section>
        ) : null}

        {stage === 'templates' ? (
          <TemplatesStage
            templates={templates}
            pythonAvailable={status?.python.available ?? false}
          />
        ) : (
          <StudyStage studies={studies} pythonAvailable={status?.python.available ?? false} />
        )}
      </main>
    </AppShell>
  );
}
