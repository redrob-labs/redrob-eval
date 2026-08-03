'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { ModelPicker, type CatalogModel } from '@/components/ModelPicker';

type RunRow = {
  id: string;
  taskId: string;
  status: string;
  createdAt: string;
  finishedAt?: string;
  modelCount: number;
  inputCount: number;
  truncationWarning?: boolean;
};

const EXAMPLE_JSONL = `{"id":"ex1","input":"Summarize this product brief for a PM.\\n\\nBrief: Acme Ship is a B2B dashboard that consolidates carrier rates, ETA predictions, and exception alerts. Target buyers are logistics managers at mid-market retailers. Differentiation is proactive delay alerts (not static tracking pages). Launch goal: 50 paid pilots in Q3."}
{"id":"ex2","input":"List three risks for shipping a mobile checkout redesign without a staging environment. Keep each risk to one sentence."}
{"id":"ex3","input":"Rewrite this error for non-engineers: \\"ECONNRESET while flushing batch to payments-ledger (timeout=5s).\\""}`;

function PreferencePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [runs, setRuns] = useState<RunRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [goal, setGoal] = useState('Write a clear, correct answer for the user task.');
  const [rubric, setRubric] = useState(
    'Prefer factual accuracy, then clarity, then brevity. Penalize hedging when the answer is knowable.',
  );
  const [examplesRaw, setExamplesRaw] = useState(EXAMPLE_JSONL);
  const [examplesFileName, setExamplesFileName] = useState<string | null>(null);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [knownModels, setKnownModels] = useState<Record<string, CatalogModel>>({});
  const [maxTokens, setMaxTokens] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const [formOpen, setFormOpen] = useState(true);
  const [showGuide, setShowGuide] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const mergeKnown = useCallback((models: CatalogModel[]) => {
    setKnownModels((prev) => {
      const next = { ...prev };
      for (const m of models) next[m.id] = m;
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/preference/runs');
      const json = (await res.json()) as { runs?: RunRow[]; error?: string };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setRuns(json.runs ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to list runs');
    }
  }, []);

  const openRun = useCallback(
    (id: string) => {
      router.push(`/preference/${encodeURIComponent(id)}`);
    },
    [router],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const legacy = searchParams.get('runId');
    if (legacy) {
      router.replace(`/preference/${encodeURIComponent(legacy)}`);
      return;
    }
    const mt = searchParams.get('maxTokens');
    if (mt != null && mt !== '') {
      const n = Number(mt);
      if (Number.isFinite(n) && n >= 1) setMaxTokens(n);
    }
  }, [searchParams, router]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/models?source=curated&limit=50');
        const json = (await res.json()) as { models?: CatalogModel[] };
        const callables = (json.models ?? []).filter(
          (m) => m.callable && m.evalEligible !== false,
        );
        mergeKnown(callables);
        setSelectedModels((prev) =>
          prev.length ? prev : callables.slice(0, 2).map((m) => m.id),
        );
      } catch {
        // ModelPicker can still load OpenRouter catalog
      }
    })();
  }, [mergeKnown]);

  async function startRun() {
    if (selectedModels.length < 2) {
      setError('Pick at least two models to compare.');
      return;
    }
    setStarting(true);
    setError(null);
    try {
      const res = await fetch('/api/preference/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelIds: selectedModels,
          customGoal: { goal, rubric, examplesRaw },
          generationParams: { maxTokens, temperature: 0, parallelSections: 1 },
        }),
      });
      const json = (await res.json()) as { runId?: string; error?: string };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      if (json.runId) {
        await refresh();
        openRun(json.runId);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start run');
    } finally {
      setStarting(false);
    }
  }

  function onExamplesFile(file: File | null) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      setExamplesRaw(text);
      setExamplesFileName(file.name);
      setError(null);
    };
    reader.onerror = () => setError(`Could not read ${file.name}`);
    reader.readAsText(file);
  }

  const canGenerate = selectedModels.length >= 2 && !starting;
  const generateBlockedReason = starting
    ? 'Starting run…'
    : selectedModels.length < 2
      ? 'Select at least two models from the catalog.'
      : null;

  return (
    <AppShell
      module="preference"
      right={
        <>
          <button
            type="button"
            className="app-ghost-btn"
            onClick={() => setShowGuide((v) => !v)}
          >
            {showGuide ? 'Hide guide' : 'Guide'}
          </button>
          <button
            type="button"
            className="app-ghost-btn"
            onClick={() => {
              setFormOpen(true);
              window.requestAnimationFrame(() => {
                document.getElementById('pref-start')?.scrollIntoView({ behavior: 'smooth' });
              });
            }}
          >
            New run
          </button>
          <button type="button" className="app-ghost-btn" onClick={() => void refresh()}>
            Refresh
          </button>
        </>
      }
    >
      <main className="pref-page">
        <div className="pref-page-head">
          <div>
            <div className="pref-page-title-row">
              <h1>Preference</h1>
              <span className="pref-preview-badge">Preview · Stage 1</span>
            </div>
            <p className="pref-page-lede">
              Stage 1 generates one completion per model × input on your Custom Goal, then opens
              a live output matrix. Inspect truncation before any future pairwise voting (Stage 2 —
              not in this UI yet).
            </p>
          </div>
        </div>

        {showGuide ? (
          <div className="module-guide" role="region" aria-label="Preference guide">
            <div className="module-guide-head">
              <strong>Preference guide</strong>
              <button
                type="button"
                className="app-ghost-btn"
                onClick={() => setShowGuide(false)}
              >
                Dismiss
              </button>
            </div>
            <ol>
              <li>Write a goal and rubric, then confirm ≥3 JSONL examples with an &quot;input&quot; field.</li>
              <li>Pick at least two models (chips above the catalog).</li>
              <li>Generate outputs — results open on their own page with a live matrix.</li>
              <li>If truncation is warned, raise max tokens or shorten the task before Stage 2 votes.</li>
            </ol>
          </div>
        ) : null}

        {error ? <div className="app-banner error">{error}</div> : null}

        {formOpen ? (
          <section className="pref-card" id="pref-start">
            <div className="pane-label">New generation run</div>
            <p className="field-hint pref-form-intro">
              Fills <code>eval/preference-runs/</code> with one completion per model × input.
              Results open on their own page.
            </p>

            <div className="pref-panels">
              <div className="pref-panel pref-panel-task">
                <div className="pane-label">Task</div>
                <label className="field">
                  <span>Goal</span>
                  <textarea
                    rows={3}
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span>Rubric</span>
                  <textarea
                    rows={3}
                    value={rubric}
                    onChange={(e) => setRubric(e.target.value)}
                  />
                </label>
                <div className="field pref-examples-field">
                  <span>Examples (JSON array or JSONL · ≥3 · each needs &quot;input&quot;)</span>
                  <div className="pref-examples-toolbar">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".jsonl,.json,text/plain,application/json"
                      className="sr-only"
                      onChange={(e) => onExamplesFile(e.target.files?.[0] ?? null)}
                    />
                    <button
                      type="button"
                      className="app-ghost-btn"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      Upload JSON / JSONL
                    </button>
                    <button
                      type="button"
                      className="app-ghost-btn"
                      onClick={() => {
                        setExamplesRaw(EXAMPLE_JSONL);
                        setExamplesFileName(null);
                        if (fileInputRef.current) fileInputRef.current.value = '';
                      }}
                    >
                      Use sample
                    </button>
                    {examplesFileName ? (
                      <span className="field-hint">{examplesFileName}</span>
                    ) : null}
                  </div>
                  <textarea
                    rows={10}
                    value={examplesRaw}
                    onChange={(e) => {
                      setExamplesRaw(e.target.value);
                      setExamplesFileName(null);
                    }}
                    spellCheck={false}
                  />
                </div>
                <div className="field">
                  <span>Max output tokens</span>
                  <label className="pref-unlimited-row">
                    <input
                      type="checkbox"
                      checked={maxTokens === null}
                      onChange={(e) =>
                        setMaxTokens(e.target.checked ? null : 4096)
                      }
                    />
                    <span>Unlimited (provider / model allowed max)</span>
                  </label>
                  {maxTokens !== null ? (
                    <input
                      type="number"
                      min={256}
                      step={256}
                      value={maxTokens}
                      onChange={(e) =>
                        setMaxTokens(Math.max(1, Number(e.target.value) || 1))
                      }
                    />
                  ) : (
                    <p className="field-hint">
                      No explicit cap is sent (Anthropic uses a high ceiling because the API
                      requires a number).
                    </p>
                  )}
                </div>
              </div>

              <div className="pref-panel pref-panel-models">
                <div className="pref-models-block">
                  <div className="pref-models-heading">
                    <div className="pane-label">Models</div>
                    <span className="pref-models-count">
                      {selectedModels.length} selected
                      {selectedModels.length < 2 ? ' · pick ≥2' : ''}
                    </span>
                  </div>
                  {selectedModels.length > 0 ? (
                    <ul className="pref-selected-chips">
                      {selectedModels.map((id) => {
                        const m = knownModels[id];
                        return (
                          <li key={id}>
                            <button
                              type="button"
                              className="pref-selected-chip"
                              title={`Remove ${m?.label ?? id}`}
                              onClick={() =>
                                setSelectedModels((prev) =>
                                  prev.filter((x) => x !== id),
                                )
                              }
                            >
                              <span>{m?.label ?? id}</span>
                              <span aria-hidden>×</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="field-hint">
                      Select at least two models from the catalog.
                    </p>
                  )}
                  <ModelPicker
                    selectedIds={selectedModels}
                    onChange={setSelectedModels}
                    knownModels={knownModels}
                    onKnown={mergeKnown}
                    selectMode="text"
                    hideHeader
                    fillHeight
                  />
                </div>
              </div>
            </div>

            <div className="pref-form-actions">
              <div>
                <button
                  type="button"
                  className="app-run-btn"
                  disabled={!canGenerate}
                  title={generateBlockedReason ?? undefined}
                  onClick={() => void startRun()}
                >
                  {starting ? 'Starting…' : 'Generate outputs'}
                </button>
                {generateBlockedReason && !starting ? (
                  <p className="cta-disabled-hint">{generateBlockedReason}</p>
                ) : null}
              </div>
              <button
                type="button"
                className="app-ghost-btn"
                onClick={() => setFormOpen(false)}
              >
                Hide form
              </button>
            </div>
          </section>
        ) : null}

        <section className="pref-card pref-past">
          <div className="pane-label">Past runs</div>
          {runs.length === 0 ? (
            <div className="pref-empty">
              <p>
                {formOpen
                  ? 'No runs yet. Complete the form above, then Generate outputs.'
                  : 'No runs yet.'}
              </p>
              {!formOpen ? (
                <button
                  type="button"
                  className="app-run-btn"
                  onClick={() => {
                    setFormOpen(true);
                    window.requestAnimationFrame(() => {
                      document
                        .getElementById('pref-start')
                        ?.scrollIntoView({ behavior: 'smooth' });
                    });
                  }}
                >
                  New run
                </button>
              ) : null}
            </div>
          ) : (
            <div className="table-scroll">
              <table className="data-table text-xs">
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Status</th>
                    <th>Models</th>
                    <th>Inputs</th>
                    <th>Truncation</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr
                      key={r.id}
                      className="pref-run-row"
                      onClick={() => openRun(r.id)}
                    >
                      <td>
                        <button
                          type="button"
                          className="pref-run-link"
                          onClick={(e) => {
                            e.stopPropagation();
                            openRun(r.id);
                          }}
                        >
                          {r.id}
                        </button>
                      </td>
                      <td>{r.status}</td>
                      <td>{r.modelCount}</td>
                      <td>{r.inputCount}</td>
                      <td>
                        {r.truncationWarning ? (
                          <span className="pref-trunc-warn">warn</span>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </AppShell>
  );
}

export default function PreferencePage() {
  return (
    <Suspense
      fallback={
        <AppShell module="preference">
          <main className="pref-page">
            <p className="field-hint">Loading Preference…</p>
          </main>
        </AppShell>
      }
    >
      <PreferencePageInner />
    </Suspense>
  );
}
