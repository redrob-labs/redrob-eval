'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { copyText, downloadJson } from '@/lib/download';
import { stashComparePrompts } from '@/lib/handoff';

import {
  STATUS_TONE,
  type CatalogLocale,
  type CatalogTemplate,
  type PreviewInstance,
  type TranslationStatus,
} from './types';

function StatusChip({ status }: { status: TranslationStatus }) {
  const { label, tone } = STATUS_TONE[status];
  return <span className={`gen-chip gen-chip-${tone}`}>{label}</span>;
}

/**
 * A locale, coloured by how reviewed it is.
 *
 * The tag has to be on the chip. Four chips reading "untranslated" three times says a
 * family has stubs but not which ones, which is the only part a reader can act on.
 */
function LocaleChip({ locale }: { locale: CatalogLocale }) {
  const { label, tone } = STATUS_TONE[locale.translationStatus];
  return (
    <span className={`gen-chip gen-chip-${tone}`} title={`${locale.tag}: ${label}`}>
      {locale.tag}
    </span>
  );
}

/**
 * What items exist, and what one actually looks like.
 *
 * The locale chips carry translation status because that is the difference between a
 * locale you can publish a number about and one that is English wearing a label. A stub
 * renders and scores exactly like a real translation, so if the page did not say which
 * was which, nothing downstream would.
 */
export function TemplatesStage({
  templates,
  pythonAvailable,
}: {
  templates: CatalogTemplate[];
  pythonAvailable: boolean;
}) {
  const router = useRouter();
  const [chosenPath, setChosenPath] = useState<string | null>(null);
  const [chosenLocale, setChosenLocale] = useState<string | null>(null);
  const [count, setCount] = useState(3);
  const [expanded, setExpanded] = useState<number | null>(0);
  /** Bumped by the Generate button, which is the only way to re-sample the same inputs. */
  const [nonce, setNonce] = useState(0);
  /** Transient feedback for the export row: copying gives nothing else to look at. */
  const [note, setNote] = useState<string | null>(null);

  // Falling back to the first entry rather than rendering an empty panel: the page is
  // reached to look at templates, and there is no reason to make that take a click.
  const template = templates.find((entry) => entry.path === chosenPath) ?? templates[0] ?? null;
  const locale =
    template?.locales.find((l) => l.tag === chosenLocale)?.tag ??
    template?.locales[0]?.tag ??
    'en';
  const path = template?.path;
  const key = `${path ?? ''}|${locale}|${nonce}`;

  // Results are stored against the request that produced them, so switching template or
  // locale shows nothing rather than briefly showing the previous template's instances.
  // That also makes "loading" derivable instead of a third state to keep in sync.
  const [result, setResult] = useState<{ key: string; instances: PreviewInstance[] } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const instances = result?.key === key ? result.instances : null;
  const error = failure?.key === key ? failure.message : null;
  const loading = pythonAvailable && path !== undefined && instances === null && error === null;

  useEffect(() => {
    if (!path || !pythonAvailable) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/generate/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ templatePath: path, locale, count }),
        });
        const body = (await res.json()) as {
          instances?: PreviewInstance[];
          error?: string;
          detail?: string;
        };
        if (cancelled) return;
        if (!res.ok) throw new Error(body.detail ? `${body.error} — ${body.detail}` : body.error);
        setResult({ key, instances: body.instances ?? [] });
        setExpanded(0);
      } catch (err) {
        if (cancelled) return;
        setFailure({ key, message: err instanceof Error ? err.message : 'preview failed' });
      }
    })();
    return () => {
      cancelled = true;
    };
    // `count` is read but not depended on: typing in the number field should not fire a
    // subprocess per keystroke. The Generate button bumps `nonce`, which is in `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, path, locale, pythonAvailable]);

  const localeStatus = template?.locales.find((l) => l.tag === locale)?.translationStatus;

  // The same sampling, written to disk instead of held in the page. Offered verbatim
  // because the seeds are content-derived: the CLI reproduces exactly what is on screen.
  const cliCommand = template
    ? `redrob-generate emit --template ${template.path} --locale ${locale} --count ${count} --out out/`
    : '';

  return (
    <div className="gen-split">
      <section className="cmp-card gen-list">
        <div className="pane-label">Template families ({templates.length})</div>
        {templates.length === 0 ? (
          <p className="gen-empty">No templates found under templates/.</p>
        ) : (
          <ul className="gen-template-list">
            {templates.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  className={`gen-template${template?.path === entry.path ? ' on' : ''}`}
                  onClick={() => setChosenPath(entry.path)}
                >
                  <span className="gen-template-title">{entry.title}</span>
                  <span className="gen-template-meta">
                    {entry.familyLabel} · {entry.verifierFamily} · {entry.parameterCount}{' '}
                    parameters
                  </span>
                  <code className="gen-template-id">{entry.id}</code>
                  <span className="gen-locale-row">
                    {entry.locales.map((l) => (
                      <LocaleChip key={l.tag} locale={l} />
                    ))}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="cmp-card gen-detail">
        {!template ? (
          <p className="gen-empty">Nothing to show until a template family is on disk.</p>
        ) : (
          <>
            <div className="gen-detail-head">
              <div>
                <h2 className="gen-title">{template.title}</h2>
                <p className="gen-subtitle">
                  {template.familyLabel} · <code>{template.id}</code> · v{template.version}
                </p>
              </div>
            </div>
            {template.description ? <p className="gen-desc">{template.description}</p> : null}

            <div className="gen-controls">
              <div className="gen-locale-picker" role="group" aria-label="Locale">
                {template.locales.map((l) => (
                  <button
                    key={l.tag}
                    type="button"
                    className={`gen-locale${locale === l.tag ? ' on' : ''}`}
                    onClick={() => setChosenLocale(l.tag)}
                  >
                    {l.tag}
                    <StatusChip status={l.translationStatus} />
                  </button>
                ))}
              </div>
              <label className="gen-count">
                instances to sample
                <input
                  type="number"
                  min={1}
                  max={25}
                  value={count}
                  onChange={(e) => setCount(Math.min(Math.max(Number(e.target.value) || 1, 1), 25))}
                />
              </label>
              <button
                type="button"
                className="app-run-btn"
                disabled={!pythonAvailable || loading}
                onClick={() => setNonce((n) => n + 1)}
              >
                {loading ? 'Generating…' : 'Generate'}
              </button>
            </div>

            {localeStatus === 'untranslated' ? (
              <p className="gen-warn">
                This locale is a stub: the prompt is the English text copied verbatim, so a
                token count measured on it describes English. It exists to exercise the
                pipeline and cannot be published.
              </p>
            ) : null}

            {error ? <p className="gen-error">{error}</p> : null}

            {!pythonAvailable ? (
              <p className="gen-empty">
                Sampling needs the Python CLI. The locales above are read from disk.
              </p>
            ) : null}

            {instances && instances.length > 0 ? (
              <div className="gen-export">
                <div className="gen-export-head">
                  <span className="gen-export-title">
                    {instances.length} instance{instances.length === 1 ? '' : 's'} sampled
                  </span>
                  {note ? <span className="gen-export-note">{note}</span> : null}
                </div>
                <div className="gen-export-actions">
                  <button
                    type="button"
                    className="app-run-btn"
                    onClick={() => {
                      const ok = stashComparePrompts({
                        label: `${template.title} (${locale})`,
                        prompts: instances.map((instance) => ({
                          id: `${template.id}#${instance.instance_index}`,
                          input: instance.prompt,
                        })),
                      });
                      if (ok) router.push('/compare');
                      else setNote('this browser blocked session storage — download instead');
                    }}
                  >
                    Compare models on these →
                  </button>
                  <button
                    type="button"
                    className="app-ghost-btn"
                    onClick={() =>
                      downloadJson(`${template.id}.${locale}.json`, {
                        template_id: template.id,
                        template_path: template.path,
                        template_version: template.version,
                        locale,
                        count: instances.length,
                        instances,
                      })
                    }
                  >
                    Download set
                  </button>
                  <button
                    type="button"
                    className="app-ghost-btn"
                    onClick={() => {
                      void copyText(
                        JSON.stringify(
                          instances.map((instance) => ({
                            id: `${template.id}#${instance.instance_index}`,
                            input: instance.prompt,
                          })),
                          null,
                          2,
                        ),
                      ).then((ok) => setNote(ok ? 'prompts copied' : 'could not reach the clipboard'));
                    }}
                  >
                    Copy prompts
                  </button>
                  <button
                    type="button"
                    className="app-ghost-btn"
                    onClick={() => {
                      void copyText(cliCommand).then((ok) =>
                        setNote(ok ? 'command copied' : 'could not reach the clipboard'),
                      );
                    }}
                    title={cliCommand}
                  >
                    Copy CLI command
                  </button>
                </div>
                <p className="gen-export-hint">
                  Sending these to Compare runs them as custom prompts. There are no
                  reference answers on that path, so rank the answers with the preference
                  tournament — the verifier stays here, with the set.
                </p>
              </div>
            ) : null}

            {instances ? (
              <div className="gen-instances">
                {instances.map((instance, index) => (
                  <article
                    key={instance.instance_index}
                    className={`gen-instance${expanded === index ? ' on' : ''}`}
                  >
                    <button
                      type="button"
                      className="gen-instance-head"
                      onClick={() => setExpanded(expanded === index ? null : index)}
                    >
                      <span className="gen-instance-n">instance {instance.instance_index}</span>
                      <span className="gen-seed">
                        seed <code>{instance.seed}</code>
                      </span>
                    </button>
                    {expanded === index ? (
                      <div className="gen-instance-body">
                        <div className="pane-label">Prompt</div>
                        <pre className="gen-prompt">{instance.prompt}</pre>
                        <div className="pane-label">Parameters</div>
                        <pre className="gen-json">
                          {JSON.stringify(instance.parameters, null, 2)}
                        </pre>
                        <div className="pane-label">Verifier that will score the answer</div>
                        <pre className="gen-json">{JSON.stringify(instance.verifier, null, 2)}</pre>
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
