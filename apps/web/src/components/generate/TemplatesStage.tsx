'use client';

import { useCallback, useState } from 'react';

import {
  STATUS_TONE,
  type CatalogTemplate,
  type PreviewInstance,
  type TranslationStatus,
} from './types';

function StatusChip({ status }: { status: TranslationStatus }) {
  const { label, tone } = STATUS_TONE[status];
  return <span className={`gen-chip gen-chip-${tone}`}>{label}</span>;
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
  const [selected, setSelected] = useState<string | null>(null);
  const [locale, setLocale] = useState('en');
  const [count, setCount] = useState(3);
  const [instances, setInstances] = useState<PreviewInstance[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(0);

  const template = templates.find((entry) => entry.path === selected) ?? null;

  const preview = useCallback(
    async (path: string, tag: string, n: number) => {
      setLoading(true);
      setError(null);
      setInstances(null);
      try {
        const res = await fetch('/api/generate/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ templatePath: path, locale: tag, count: n }),
        });
        const body = (await res.json()) as {
          instances?: PreviewInstance[];
          error?: string;
          detail?: string;
        };
        if (!res.ok) throw new Error(body.detail ? `${body.error} — ${body.detail}` : body.error);
        setInstances(body.instances ?? []);
        setExpanded(0);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'preview failed');
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const select = useCallback(
    (entry: CatalogTemplate) => {
      setSelected(entry.path);
      const tag = entry.locales.some((l) => l.tag === locale) ? locale : (entry.locales[0]?.tag ?? 'en');
      setLocale(tag);
      setInstances(null);
      setError(null);
      if (pythonAvailable) void preview(entry.path, tag, count);
    },
    [count, locale, preview, pythonAvailable],
  );

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
                  className={`gen-template${selected === entry.path ? ' on' : ''}`}
                  onClick={() => select(entry)}
                >
                  <span className="gen-template-id">{entry.id}</span>
                  <span className="gen-template-meta">
                    {entry.verifierFamily} · {entry.parameterCount} parameters
                  </span>
                  <span className="gen-locale-row">
                    {entry.locales.map((l) => (
                      <StatusChip key={l.tag} status={l.translationStatus} />
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
          <p className="gen-empty">Pick a template family to see its locales and a sample.</p>
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
                    onClick={() => {
                      setLocale(l.tag);
                      if (pythonAvailable) void preview(template.path, l.tag, count);
                    }}
                  >
                    {l.tag}
                    <StatusChip status={l.translationStatus} />
                  </button>
                ))}
              </div>
              <label className="gen-count">
                instances
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
                onClick={() => void preview(template.path, locale, count)}
              >
                {loading ? 'Generating…' : 'Generate'}
              </button>
            </div>

            {template.locales.find((l) => l.tag === locale)?.translationStatus ===
            'untranslated' ? (
              <p className="gen-warn">
                This locale is a stub: the prompt is the English text copied verbatim, so a
                token count measured on it describes English. It exists to exercise the
                pipeline and cannot be published.
              </p>
            ) : null}

            {error ? <p className="gen-error">{error}</p> : null}

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
                      <span className="gen-instance-n">#{instance.instance_index}</span>
                      <code className="gen-seed" title="Seed, derived from the template id and index">
                        {instance.seed}
                      </code>
                    </button>
                    {expanded === index ? (
                      <div className="gen-instance-body">
                        <div className="pane-label">Prompt</div>
                        <pre className="gen-prompt">{instance.prompt}</pre>
                        <div className="pane-label">Parameters</div>
                        <pre className="gen-json">
                          {JSON.stringify(instance.parameters, null, 2)}
                        </pre>
                        <div className="pane-label">Expected</div>
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
