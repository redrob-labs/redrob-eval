'use client';

import { useCallback, useState } from 'react';

import { useT } from '@/components/LocaleProvider';
import type { MessageKey } from '@/lib/i18n';
import { downloadJson, downloadText } from '@/lib/download';

import { type StudyConfigSummary, type StudyRunResponse, type TranslationStatus } from './types';

const STATUS_KEYS: Record<TranslationStatus, { labelKey: MessageKey; tone: string }> = {
  'native-reviewed': { labelKey: 'generate.status.nativeReviewed', tone: 'ok' },
  'single-reviewer': { labelKey: 'generate.status.singleReviewer', tone: 'warn' },
  untranslated: { labelKey: 'generate.status.untranslated', tone: 'stub' },
};

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
  const t = useT();
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
      if (!res.ok) throw new Error(body.detail ? `${body.error}: ${body.detail}` : body.error);
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
        <div className="pane-label">{t('generate.study.config')}</div>
        {studies.length === 0 ? (
          <p className="gen-empty">{t('generate.study.none')}</p>
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
                  <span className="gen-chip gen-chip-ok">{t('generate.study.mockOnly')}</span>
                ) : (
                  <span className="gen-chip gen-chip-warn">{t('generate.study.callsProviders')}</span>
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
            {running ? t('generate.study.running') : t('generate.study.runStudy')}
          </button>
          {config && !config.offline ? (
            <span className="gen-warn-inline">{t('generate.study.reachesProviders')}</span>
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
                {t('generate.study.resultArtifactFor', { studyId: run.result.study_id })}
              </span>
              <span
                className={`gen-chip gen-chip-${run.publishable ? 'ok' : 'stub'}`}
                title={
                  run.publishable
                    ? t('generate.study.passedGate')
                    : t('generate.study.refusedPublication')
                }
              >
                {run.publishable ? t('generate.study.publishable') : t('generate.study.notPublishable')}
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
                {t('generate.study.downloadArtifact')}
              </button>
              <button
                type="button"
                className="app-ghost-btn"
                onClick={() => downloadText(`${run.result.study_id}.table.txt`, run.table)}
              >
                {t('generate.study.downloadTable')}
              </button>
            </div>
            <p className="gen-export-hint">{t('generate.study.artifactHint')}</p>
          </section>

          <section className="cmp-card">
            <div className="pane-label">{t('generate.study.provenance')}</div>
            <p className="gen-desc">{t('generate.study.provenanceHint')}</p>
            <ul className="gen-provenance">
              {run.result.provenance.runtimes.map((runtime) => (
                <li key={runtime.implementation}>
                  <code>{runtime.implementation}</code> {runtime.implementation_version} · Unicode{' '}
                  {runtime.unicode_version}{' '}
                  <span
                    className={`gen-chip gen-chip-${runtime.authoritative ? 'ok' : 'stub'}`}
                    title={
                      runtime.authoritative
                        ? t('generate.study.authoritativeTitle')
                        : t('generate.study.displayOnlyTitle')
                    }
                  >
                    {runtime.authoritative
                      ? t('generate.study.authoritative')
                      : t('generate.study.displayOnly')}
                  </span>
                </li>
              ))}
              <li>
                {t('generate.study.tokenizer')} <code>{run.result.provenance.tokenizer.name}</code>{' '}
                {run.result.provenance.tokenizer.version}
                <span className="gen-chip gen-chip-warn" title={t('generate.study.offlineProxyTitle')}>
                  {t('generate.study.offlineProxy')}
                </span>
              </li>
            </ul>
          </section>

          {!run.publishable ? (
            <section className="cmp-card gen-notice gen-notice-error">
              <div className="pane-label">{t('generate.study.refused')}</div>
              {run.refusal ? <pre className="gen-json">{run.refusal}</pre> : null}
              {stubs.length > 0 ? (
                <p>
                  {t('generate.study.stubsWarning', {
                    locales: stubs.map((l) => l.tag).join(', '),
                  })}
                </p>
              ) : null}
            </section>
          ) : null}

          <section className="cmp-card">
            <div className="pane-label">{t('generate.study.locales')}</div>
            <div className="table-scroll">
              <table className="data-table text-xs">
                <thead>
                  <tr>
                    <th>{t('generate.study.table.locale')}</th>
                    <th>{t('generate.study.table.fertility')}</th>
                    <th>{t('generate.study.table.resource')}</th>
                    <th>{t('generate.study.table.translation')}</th>
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
                          className={`gen-chip gen-chip-${STATUS_KEYS[l.translation_status].tone}`}
                        >
                          {t(STATUS_KEYS[l.translation_status].labelKey)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="cmp-card">
            <div className="pane-label">{t('generate.study.pairedDeltas')}</div>
            <div className="table-scroll">
              <table className="data-table text-xs">
                <thead>
                  <tr>
                    <th>{t('generate.study.table.comparison')}</th>
                    <th>{t('generate.study.table.left')}</th>
                    <th>{t('generate.study.table.right')}</th>
                    <th>{t('generate.study.table.pairs')}</th>
                    <th>{t('generate.study.table.tokensLeft')}</th>
                    <th>{t('generate.study.table.tokensRight')}</th>
                    <th>{t('generate.study.table.tokenDelta')}</th>
                    <th>{t('generate.study.table.accuracyDelta')}</th>
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
            <div className="pane-label">{t('generate.study.meanTokensPerLocale')}</div>
            <div className="table-scroll">
              <table className="data-table text-xs">
                <thead>
                  <tr>
                    <th>{t('generate.study.table.locale')}</th>
                    <th>{t('generate.study.table.n')}</th>
                    <th>{t('generate.study.table.meanTokens')}</th>
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
            <div className="pane-label">{t('generate.study.accuracyPerLocale')}</div>
            <div className="table-scroll">
              <table className="data-table text-xs">
                <thead>
                  <tr>
                    <th>{t('generate.study.table.model')}</th>
                    <th>{t('generate.study.table.locale')}</th>
                    <th>{t('generate.study.table.verifierFamily')}</th>
                    <th>{t('generate.study.table.n')}</th>
                    <th>{t('generate.study.table.passed')}</th>
                    <th>{t('generate.study.table.accuracy')}</th>
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
