'use client';

import { useCallback, useState } from 'react';

import { downloadJson, downloadText } from '@/lib/download';

import { STATUS_TONE, type StudyConfigSummary, type StudyRunResponse } from './types';

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)}`;
}

/**
 * Run a study and show the numbers.
 *
 * The artifact carries no interpretation and neither does this view. What it does add is
 * the two things a reader needs in order not to over-read the table: which locales were
 * placeholders, and which implementation produced the verdicts.
 */
export function StudyStage({
  studies,
  pythonAvailable,
}: {
  studies: StudyConfigSummary[];
  pythonAvailable: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(studies[0]?.path ?? null);
  const [run, setRun] = useState<StudyRunResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const config = studies.find((entry) => entry.path === selected) ?? studies[0] ?? null;

  const start = useCallback(async (configPath: string) => {
    setRunning(true);
    setError(null);
    setRun(null);
    try {
      const res = await fetch('/api/generate/study', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ configPath, offlineOnly: true }),
      });
      const body = (await res.json()) as StudyRunResponse & { error?: string; detail?: string };
      if (!res.ok) throw new Error(body.detail ? `${body.error} — ${body.detail}` : body.error);
      setRun(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'the study failed');
    } finally {
      setRunning(false);
    }
  }, []);

  const stubs = run?.result.locales.filter((l) => l.translation_status === 'untranslated') ?? [];

  return (
    <div className="gen-study">
      <section className="cmp-card">
        <div className="pane-label">Study config</div>
        {studies.length === 0 ? (
          <p className="gen-empty">No study configs found under packages/generate/examples/.</p>
        ) : (
          <div className="gen-study-picker">
            {studies.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className={`gen-study-option${config?.path === entry.path ? ' on' : ''}`}
                onClick={() => setSelected(entry.path)}
              >
                <span className="gen-template-title">{entry.title}</span>
                <span className="gen-template-meta">
                  {entry.templateCount} templates · {entry.localeTags.join(', ')} ·{' '}
                  {entry.modelIds.length} models · {entry.tokenizer}
                </span>
                <code className="gen-template-id">{entry.id}</code>
                {entry.offline ? (
                  <span className="gen-chip gen-chip-ok">mock only, no spend</span>
                ) : (
                  <span className="gen-chip gen-chip-warn">calls providers</span>
                )}
              </button>
            ))}
          </div>
        )}

        {config?.description ? <p className="gen-desc">{config.description}</p> : null}

        <div className="gen-controls">
          <button
            type="button"
            className="app-run-btn"
            disabled={!pythonAvailable || running || !config || !config.offline}
            onClick={() => config && void start(config.path)}
          >
            {running ? 'Running…' : 'Run study'}
          </button>
          {config && !config.offline ? (
            <span className="gen-warn-inline">
              This config reaches providers. Run it from the CLI, where the spend is
              deliberate.
            </span>
          ) : null}
        </div>

        {error ? <p className="gen-error">{error}</p> : null}
      </section>

      {run ? (
        <>
          {/* The artifact is the deliverable — the tables below are a reading of it — so
              it is offered before them rather than at the bottom of the page. */}
          <section className="cmp-card gen-export">
            <div className="gen-export-head">
              <span className="gen-export-title">
                Result artifact for <code>{run.result.study_id}</code>
              </span>
              <span
                className={`gen-chip gen-chip-${run.publishable ? 'ok' : 'stub'}`}
                title={
                  run.publishable
                    ? 'Passed the publication gate'
                    : 'Refused publication — see the reason below'
                }
              >
                {run.publishable ? 'publishable' : 'not publishable'}
              </span>
            </div>
            <div className="gen-export-actions">
              <button
                type="button"
                className="app-run-btn"
                onClick={() =>
                  downloadJson(`${run.result.study_id}.result.json`, run.result)
                }
              >
                Download artifact
              </button>
              <button
                type="button"
                className="app-ghost-btn"
                onClick={() => downloadText(`${run.result.study_id}.table.txt`, run.table)}
              >
                Download table
              </button>
            </div>
            <p className="gen-export-hint">
              The JSON is the whole run: provenance, every instance, and the aggregates the
              tables below are drawn from. Nothing is written to the repository by this
              page, so this download is the only copy.
            </p>
          </section>

          <section className="cmp-card">
            <div className="pane-label">Provenance</div>
            <p className="gen-desc">
              Both runtimes are listed because they read different Unicode tables, which is
              the whole reason only one of them may be published from.
            </p>
            <ul className="gen-provenance">
              {run.result.provenance.runtimes.map((runtime) => (
                <li key={runtime.implementation}>
                  <code>{runtime.implementation}</code> {runtime.implementation_version} · Unicode{' '}
                  {runtime.unicode_version}{' '}
                  <span
                    className={`gen-chip gen-chip-${runtime.authoritative ? 'ok' : 'stub'}`}
                    title={
                      runtime.authoritative
                        ? 'Verdicts from this implementation may be published'
                        : 'Display only: the two runtimes read different Unicode tables'
                    }
                  >
                    {runtime.authoritative ? 'authoritative' : 'display only'}
                  </span>
                </li>
              ))}
              <li>
                tokenizer <code>{run.result.provenance.tokenizer.name}</code>{' '}
                {run.result.provenance.tokenizer.version}
                <span className="gen-chip gen-chip-warn" title="Not a model tokenizer">
                  offline proxy
                </span>
              </li>
            </ul>
          </section>

          {!run.publishable ? (
            <section className="cmp-card gen-notice gen-notice-error">
              <div className="pane-label">Refused for publication</div>
              {run.refusal ? <pre className="gen-json">{run.refusal}</pre> : null}
              {stubs.length > 0 ? (
                <p>
                  {stubs.map((l) => l.tag).join(', ')} render placeholder text, so every
                  per-locale number below measures the placeholder rather than the locale.
                  The deltas are zero for the same reason: the stubs are the English prompt
                  byte for byte, so there is nothing for a tokenizer to find.
                </p>
              ) : null}
            </section>
          ) : null}

          <section className="cmp-card">
            <div className="pane-label">Locales</div>
            <div className="table-scroll">
              <table className="data-table text-xs">
                <thead>
                  <tr>
                    <th>Locale</th>
                    <th>Fertility</th>
                    <th>Resource</th>
                    <th>Translation</th>
                  </tr>
                </thead>
                <tbody>
                  {run.result.locales.map((l) => (
                    <tr key={l.tag}>
                      <td>
                        <code>{l.tag}</code>
                      </td>
                      <td>{l.fertility_level}</td>
                      <td>{l.resource_level}</td>
                      <td>
                        <span
                          className={`gen-chip gen-chip-${STATUS_TONE[l.translation_status].tone}`}
                        >
                          {STATUS_TONE[l.translation_status].label}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="cmp-card">
            <div className="pane-label">Paired deltas (right minus left, matched on item)</div>
            <div className="table-scroll">
              <table className="data-table text-xs">
                <thead>
                  <tr>
                    <th>Comparison</th>
                    <th>Left</th>
                    <th>Right</th>
                    <th>Pairs</th>
                    <th>Tokens left</th>
                    <th>Tokens right</th>
                    <th>Token delta</th>
                    <th>Accuracy delta</th>
                  </tr>
                </thead>
                <tbody>
                  {run.result.aggregates.paired_deltas.map((row) => (
                    <tr key={row.comparison}>
                      <td>{row.comparison}</td>
                      <td>
                        <code>{row.left}</code>
                      </td>
                      <td>
                        <code>{row.right}</code>
                      </td>
                      <td>{row.n_pairs}</td>
                      <td>{row.mean_prompt_tokens_left.toFixed(1)}</td>
                      <td>{row.mean_prompt_tokens_right.toFixed(1)}</td>
                      <td>{signed(row.mean_prompt_tokens_delta)}</td>
                      <td>{signed(row.accuracy_delta)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="cmp-card">
            <div className="pane-label">Mean prompt tokens per locale</div>
            <div className="table-scroll">
              <table className="data-table text-xs">
                <thead>
                  <tr>
                    <th>Locale</th>
                    <th>n</th>
                    <th>Mean tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {run.result.aggregates.tokens.map((row) => (
                    <tr key={row.locale}>
                      <td>
                        <code>{row.locale}</code>
                      </td>
                      <td>{row.n}</td>
                      <td>{row.mean_prompt_tokens.toFixed(3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="cmp-card">
            <div className="pane-label">Accuracy per locale per verifier family</div>
            <div className="table-scroll">
              <table className="data-table text-xs">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Locale</th>
                    <th>Verifier family</th>
                    <th>n</th>
                    <th>Passed</th>
                    <th>Accuracy</th>
                  </tr>
                </thead>
                <tbody>
                  {run.result.aggregates.accuracy.map((row) => (
                    <tr key={`${row.model_id}/${row.locale}/${row.verifier_family}`}>
                      <td>
                        <code>{row.model_id}</code>
                      </td>
                      <td>
                        <code>{row.locale}</code>
                      </td>
                      <td>{row.verifier_family}</td>
                      <td>{row.n}</td>
                      <td>{row.passed}</td>
                      <td>{pct(row.accuracy)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
