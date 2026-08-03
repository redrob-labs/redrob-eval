'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { MODULES } from '@/lib/modules';

const GUIDE_STEPS = [
  {
    n: 1,
    title: 'Add a provider key',
    detail:
      'Copy .env.example → .env at the repo root. Set OPENROUTER_API_KEY (or another provider), then restart yarn dev.',
  },
  {
    n: 2,
    title: 'Pick a path',
    detail:
      'Compare shortlists models. Evolve searches configs under a quality floor. Route / Image / Preference collect evidence.',
  },
  {
    n: 3,
    title: 'Relative cost only',
    detail:
      'Every cost figure is % of a baseline — never absolute currency. Keys stay in server .env.',
  },
  {
    n: 4,
    title: 'Prefer your task over public Elo',
    detail:
      'Preference Stage 1 generates on your Custom Goal so you can inspect outputs and truncation. Pairwise voting comes later (Stage 2).',
  },
] as const;

type StatusPayload = {
  port?: number;
  providers?: { id: string; configured: boolean }[];
};

export function HomeHub() {
  const [keys, setKeys] = useState<{ configured: number; total: number } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/status');
        if (!res.ok) return;
        const json = (await res.json()) as StatusPayload;
        const providers = json.providers ?? [];
        setKeys({
          configured: providers.filter((p) => p.configured).length,
          total: providers.length,
        });
      } catch {
        // offline / cold start
      }
    })();
  }, []);

  const keysReady = (keys?.configured ?? 0) > 0;

  return (
    <AppShell
      module="home"
      port={3939}
      right={
        keys == null ? null : keysReady ? (
          <span className="app-muted">
            keys {keys.configured}/{keys.total}
          </span>
        ) : (
          <a href="#home-guide" className="app-ghost-btn">
            Add a key
          </a>
        )
      }
    >
      <main className="home-saas">
        <div className="home-saas-atmosphere" aria-hidden />

        <div className="home-saas-grid">
          <section className="home-saas-col home-saas-col-main">
            <p className="home-saas-kicker">Eval workbench</p>
            <h1 className="home-saas-brand">redrob-eval</h1>
            <p className="home-saas-lede">
              Evolve configs, collect routing and preference evidence, and shortlist models
              on quality, human preference, relative cost, and latency — under your task,
              not a public leaderboard alone.
            </p>
            <div className="home-saas-cta">
              <Link href="/compare" className="home-saas-primary">
                Start with Compare
              </Link>
              <Link href="/evolve" className="home-saas-secondary">
                Open Evolve
              </Link>
            </div>
            <p className="home-saas-status">
              {keys == null ? (
                'Checking provider keys…'
              ) : keysReady ? (
                <>
                  <span className="home-saas-dot ok" />
                  {keys.configured}/{keys.total} providers configured
                </>
              ) : (
                <>
                  <span className="home-saas-dot warn" />
                  No keys yet —{' '}
                  <a href="#home-guide" className="home-saas-inline-link">
                    see Quick start
                  </a>
                </>
              )}
            </p>

            <div className="home-saas-modules-block">
              <div className="home-saas-section-head">
                <h2>Modules</h2>
                <span className="home-saas-section-note">Loop order · each its own page</span>
              </div>
              <ul className="home-saas-modules">
                {MODULES.map((m) => (
                  <li key={m.id}>
                    <Link href={m.href} className="home-saas-module">
                      <span className="home-saas-module-label">
                        {m.label}
                        {m.badge ? (
                          <span className="home-saas-module-badge">{m.badge}</span>
                        ) : null}
                      </span>
                      <span className="home-saas-module-blurb">{m.blurb}</span>
                      <span className="home-saas-module-go" aria-hidden>
                        →
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <aside className="home-saas-col home-saas-col-side" id="home-guide">
            <div className="home-saas-panel">
              <div className="home-saas-section-head">
                <h2>Quick start</h2>
              </div>
              <ol className="home-saas-steps">
                {GUIDE_STEPS.map((s) => (
                  <li key={s.n} className="home-saas-step">
                    <span className="home-saas-step-n" aria-hidden>
                      {s.n}
                    </span>
                    <div>
                      <strong>{s.title}</strong>
                      <p>{s.detail}</p>
                    </div>
                  </li>
                ))}
              </ol>
              <p className="home-saas-docs">
                Docs:{' '}
                <a
                  href="https://github.com/savagemanage/redrob-eval/blob/main/docs/methodology.md"
                  target="_blank"
                  rel="noreferrer"
                >
                  methodology
                </a>
                ,{' '}
                <a
                  href="https://github.com/savagemanage/redrob-eval/blob/main/docs/compare.md"
                  target="_blank"
                  rel="noreferrer"
                >
                  compare
                </a>
                ,{' '}
                <a
                  href="https://github.com/savagemanage/redrob-eval/blob/main/docs/preference.md"
                  target="_blank"
                  rel="noreferrer"
                >
                  preference
                </a>
                .
              </p>
            </div>
          </aside>
        </div>
      </main>
    </AppShell>
  );
}
