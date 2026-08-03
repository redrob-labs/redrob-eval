'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';

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

/**
 * Stage 1 preference generation — list runs + truncation warnings.
 * Voting UI arrives in Stage 2.
 */
export default function PreferencePage() {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    truncationWarning?: boolean;
    truncationWarningMessage?: string;
    summary?: unknown;
  } | null>(null);

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

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function openRun(id: string) {
    setSelected(id);
    const res = await fetch(`/api/preference/runs/${encodeURIComponent(id)}`);
    const json = await res.json();
    if (!res.ok) {
      setError(json.error || `HTTP ${res.status}`);
      return;
    }
    setDetail(json);
  }

  return (
    <AppShell
      module="preference"
      right={
        <button type="button" className="app-ghost-btn" onClick={() => void refresh()}>
          Refresh
        </button>
      }
    >
      <main className="compare-panel flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-xl font-bold text-slate-900">
            Preference
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Stage 1: task-grounded generation (Custom Goal × K models). Start runs via{' '}
            <code className="text-xs">POST /api/preference/runs</code>. Do not collect votes while{' '}
            <span className="text-amber-800">truncationWarning</span> is set — that measures the
            token cap, not the model. See <code className="text-xs">docs/preference.md</code>.
          </p>
        </div>
        {error ? <div className="app-banner error">{error}</div> : null}
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
              {runs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-slate-500">
                    No preference runs yet.
                  </td>
                </tr>
              ) : (
                runs.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <button
                        type="button"
                        className="underline-offset-2 hover:underline"
                        onClick={() => void openRun(r.id)}
                      >
                        {r.id}
                      </button>
                    </td>
                    <td>{r.status}</td>
                    <td>{r.modelCount}</td>
                    <td>{r.inputCount}</td>
                    <td>
                      {r.truncationWarning ? (
                        <span className="rounded bg-amber-100 px-1 text-amber-900">warn</span>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {selected && detail ? (
          <section className="rounded-lg border border-slate-200 bg-white/60 p-3 text-sm">
            <div className="pane-label">{selected}</div>
            {detail.truncationWarning ? (
              <div className="app-banner warn mt-2">
                {detail.truncationWarningMessage ||
                  'Truncation detected — fix maxTokens before voting.'}
              </div>
            ) : (
              <p className="text-xs text-slate-500">No truncation warning on this summary.</p>
            )}
          </section>
        ) : null}
      </main>
    </AppShell>
  );
}
