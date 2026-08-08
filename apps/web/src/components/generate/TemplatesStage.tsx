'use client';

import { useEffect, useState } from 'react';

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
  const [chosenPath, setChosenPath] = useState<string | null>(null);
  const [chosenLocale, setChosenLocale] = useState<string | null>(null);
  const [count, setCount] = useState(3);
  const [expanded, setExpanded] = useState<number | null>(0);
  /** Bumped by the Generate button, which is the only way to re-sample the same inputs. */
  const [nonce, setNonce] = useState(0);

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
                  <span className="gen-template-id">{entry.id}</span>
                  <span className="gen-template-meta">
                    {entry.verifierFamily} · {entry.parameterCount} parameters
                  </span>
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
            <div className="pane-label">{template.id}</div>
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
