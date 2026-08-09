'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { FilePickerModal } from '@/components/FilePickerModal';
import { ThemeSwitch } from '@/components/ThemeSwitch';

type Setting = {
  key: string;
  label: string;
  group: 'providers' | 'selfhosted' | 'gpu';
  kind: 'secret' | 'plain' | 'path';
  hint?: string;
  placeholder?: string;
  defaultValue: string | null;
  value: string | null;
  effective: string | null;
  set: boolean;
};

type Payload = {
  settings: Setting[];
  providers: { id: string; label: string; configured: boolean }[];
  envFile: string;
};

/**
 * `appearance` is a section like the others even though it saves nothing, because from
 * the reader's side it is one of the four things this page is for. Keeping it out of the
 * nav to reflect the implementation detail would only make it harder to find.
 */
type SectionId = 'appearance' | Setting['group'];

const SECTIONS: { id: SectionId; title: string; blurb: string; summary: string }[] = [
  {
    id: 'appearance',
    title: 'Appearance',
    blurb:
      'Stored in this browser, not in .env, and applied immediately — there is nothing to save.',
    summary: 'Theme',
  },
  {
    id: 'providers',
    title: 'Provider API keys',
    blurb: 'Hosted models. Stored in the repo-root .env and applied right away — no restart.',
    summary: 'OpenRouter, OpenAI, Anthropic and the rest',
  },
  {
    id: 'selfhosted',
    title: 'Self-hosted vLLM',
    blurb:
      'Endpoints for your own axes. vLLM API key is auto-issued on first Install. Hugging Face token is yours — create at huggingface.co/settings/tokens.',
    summary: 'Endpoints and Hugging Face token',
  },
  {
    id: 'gpu',
    title: 'GPU host (SSH)',
    blurb: 'Used by Deploy. The private key stays on this machine — only its path is stored.',
    summary: 'Host, user and key used by Deploy',
  },
];

const HF_TOKEN_URL = 'https://huggingface.co/settings/tokens';

export function SettingsApp() {
  const [data, setData] = useState<Payload | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [section, setSection] = useState<SectionId>('providers');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/settings');
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `HTTP ${res.status}`);
        return;
      }
      setData((await res.json()) as Payload);
    } catch {
      setError('Could not reach the workbench server.');
    }
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(() => void load());
    return () => cancelAnimationFrame(frame);
  }, [load]);

  // Deploy links here as /settings#HF_TOKEN — open the pane that holds the field, then
  // jump to and highlight it. Selecting the pane first matters now that the other panes
  // are not rendered: without it the deep link would land on an element that is not there.
  useEffect(() => {
    if (!data) return;
    let settle = 0;
    const reveal = () => {
      const hash = window.location.hash.replace(/^#/, '');
      if (!hash) return;
      const target = data.settings.find((s) => s.key === hash);
      if (target) setSection(target.group);
      setFocusKey(hash);
      // The field exists only once the pane holding it has rendered, so the scroll waits
      // a frame past the state change rather than looking for an element that is not there.
      settle = requestAnimationFrame(() => {
        const el = document.getElementById(`field-${hash}`);
        if (!el) return;
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        try {
          el.focus();
        } catch {
          /* ignore */
        }
      });
    };

    // Also on hashchange: arriving from Deploy is a full navigation, but pasting
    // `/settings#HF_TOKEN` while already here changes only the hash, and React would
    // otherwise never hear about it.
    const frame = requestAnimationFrame(reveal);
    window.addEventListener('hashchange', reveal);
    return () => {
      cancelAnimationFrame(frame);
      if (settle) cancelAnimationFrame(settle);
      window.removeEventListener('hashchange', reveal);
    };
  }, [data]);

  const dirty = useMemo(() => Object.keys(drafts).length > 0, [drafts]);

  const save = async () => {
    if (!dirty) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: drafts }),
      });
      const json = (await res.json()) as Partial<Payload> & {
        error?: string;
        applied?: string[];
      };
      if (!res.ok) {
        setError(json.error ?? 'Failed to save');
        return;
      }
      if (json.settings && json.providers) {
        setData((prev) => ({
          settings: json.settings!,
          providers: json.providers!,
          envFile: prev?.envFile ?? '',
        }));
      }
      setDrafts({});
      setMessage(`Saved ${json.applied?.length ?? 0} value(s) — active now.`);
    } catch {
      setError('Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const setDraft = (key: string, value: string) =>
    setDrafts((d) => ({ ...d, [key]: value }));

  const clearValue = (key: string) => setDraft(key, '');

  const settingsByGroup = (group: Setting['group']) =>
    (data?.settings ?? []).filter((s) => s.group === group);

  /** "2 / 6" for the nav. Counts a pending draft as set, since that is what Save will do. */
  const groupCount = (group: Setting['group']) => {
    const rows = settingsByGroup(group);
    const set = rows.filter((s) => {
      const draft = drafts[s.key];
      return draft === undefined ? s.set : draft !== '';
    }).length;
    return { set, total: rows.length };
  };

  /** Unsaved fields in a pane other than the one on screen, so Save is never a surprise. */
  const draftsElsewhere = Object.keys(drafts).filter(
    (key) => data?.settings.find((s) => s.key === key)?.group !== section,
  ).length;

  const active = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]!;

  const currentPathValue = pickerFor
    ? (drafts[pickerFor] ??
        data?.settings.find((s) => s.key === pickerFor)?.effective ??
        '')
    : '';

  return (
    <AppShell module="settings">
      <main className="settings-layout">
        <aside className="settings-nav" aria-label="Settings sections">
          <div className="settings-nav-head">
            <h1 className="settings-h1">Settings</h1>
            <p className="settings-lede">
              Keys and host details live here instead of in a hand-edited file. Secrets are
              written to the gitignored repo-root <code>.env</code> and never sent back to
              the browser — you only see whether a value is set and its last 4 characters.
            </p>
          </div>

          <ul className="settings-nav-list">
            {SECTIONS.map((s) => {
              const counts = s.id === 'appearance' ? null : groupCount(s.id);
              const pending = Object.keys(drafts).some(
                (key) => data?.settings.find((row) => row.key === key)?.group === s.id,
              );
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    className={`settings-nav-item${section === s.id ? ' on' : ''}`}
                    aria-current={section === s.id ? 'page' : undefined}
                    onClick={() => setSection(s.id)}
                  >
                    <span className="settings-nav-title">
                      {s.title}
                      {pending ? (
                        <span className="settings-nav-dot" title="Unsaved changes" />
                      ) : null}
                    </span>
                    <span className="settings-nav-sub">
                      {counts ? `${counts.set} of ${counts.total} set` : s.summary}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {data?.envFile ? (
            <p className="settings-note">
              Writing to <code>{data.envFile}</code>
            </p>
          ) : null}
        </aside>

        <section className="settings-pane">
          <div className="settings-pane-head">
            <h2>{active.title}</h2>
            <p>{active.blurb}</p>
          </div>

          {error ? <p className="settings-error">{error}</p> : null}
          {message ? <p className="settings-ok">{message}</p> : null}

          {section === 'appearance' ? (
            <div className="settings-rows">
              <div className="settings-row">
                <label className="settings-label">
                  <span className="settings-label-main">Colour theme</span>
                  <span className="settings-hint">
                    System follows your operating system and changes with it.
                  </span>
                </label>
                <ThemeSwitch />
              </div>
            </div>
          ) : null}

          {section !== 'appearance' && !data && !error ? (
            <p className="settings-note">Checking saved settings…</p>
          ) : null}

          {section !== 'appearance' && data ? (
            <div className="settings-rows">
              {settingsByGroup(section).map((s) => {
                const draft = drafts[s.key];
                const hasDraft = draft !== undefined;
                const usingDefault =
                  Boolean(s.defaultValue) &&
                  ((hasDraft && draft === '') || (!hasDraft && !s.set));
                const displayValue = (() => {
                  if (s.kind === 'secret') {
                    if (hasDraft) return draft;
                    return '';
                  }
                  if (hasDraft) return draft !== '' ? draft : (s.defaultValue ?? '');
                  return s.effective ?? s.defaultValue ?? '';
                })();
                return (
                  <div
                    key={s.key}
                    className={`settings-row${focusKey === s.key ? ' is-focus' : ''}`}
                  >
                    <label className="settings-label" htmlFor={`field-${s.key}`}>
                      <span className="settings-label-main">
                        {s.label}
                        <span
                          className={`settings-dot ${s.set || (hasDraft && draft !== '') ? 'on' : 'off'}`}
                          aria-hidden
                        />
                        {usingDefault ? (
                          <span className="settings-default-tag">default</span>
                        ) : null}
                      </span>
                      <code className="settings-key">{s.key}</code>
                      {s.hint ? <span className="settings-hint">{s.hint}</span> : null}
                      {s.key === 'HF_TOKEN' ? (
                        <a
                          className="settings-hint-link"
                          href={HF_TOKEN_URL}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open Hugging Face tokens →
                        </a>
                      ) : null}
                    </label>

                    <div className="settings-control">
                      <input
                        id={`field-${s.key}`}
                        type={s.kind === 'secret' ? 'password' : 'text'}
                        className={`settings-input${usingDefault ? ' is-default' : ''}`}
                        value={displayValue}
                        placeholder={
                          s.kind === 'secret' && s.set
                            ? `${s.value} (set — type to replace)`
                            : (s.placeholder ?? s.defaultValue ?? '')
                        }
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(e) => setDraft(s.key, e.target.value)}
                      />
                      {s.kind === 'path' ? (
                        <button
                          type="button"
                          className="app-ghost-btn"
                          onClick={() => setPickerFor(s.key)}
                        >
                          Browse…
                        </button>
                      ) : null}
                      {s.set || (hasDraft && draft !== '') ? (
                        <button
                          type="button"
                          className="app-ghost-btn"
                          onClick={() => clearValue(s.key)}
                          title={
                            s.defaultValue
                              ? 'Clear and use default'
                              : 'Clear this value'
                          }
                        >
                          Clear
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}

          {/* Pinned to the bottom of the pane. Save applies every pane's edits at once, so
              it says how many are outstanding elsewhere rather than letting the reader
              discover that by pressing it. */}
          {section !== 'appearance' && data ? (
            <div className="settings-actions">
              <button
                type="button"
                className="app-run-btn"
                onClick={save}
                disabled={!dirty || saving}
              >
                {saving ? 'Saving…' : dirty ? 'Save changes' : 'No changes'}
              </button>
              {dirty ? (
                <button type="button" className="app-ghost-btn" onClick={() => setDrafts({})}>
                  Discard
                </button>
              ) : null}
              {draftsElsewhere > 0 ? (
                <span className="settings-hint">
                  {draftsElsewhere} unsaved change{draftsElsewhere === 1 ? '' : 's'} in another
                  section, saved together
                </span>
              ) : null}
            </div>
          ) : null}
        </section>
      </main>

      <FilePickerModal
        open={pickerFor != null}
        initialDir={
          currentPathValue
            ? currentPathValue.replace(/[\\/][^\\/]*$/, '')
            : null
        }
        onPick={(filePath) => {
          if (pickerFor) setDraft(pickerFor, filePath);
          setPickerFor(null);
        }}
        onClose={() => setPickerFor(null)}
      />
    </AppShell>
  );
}
