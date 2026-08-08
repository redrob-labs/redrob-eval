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

const GROUPS: { id: Setting['group']; title: string; blurb: string }[] = [
  {
    id: 'providers',
    title: 'Provider API keys',
    blurb: 'Hosted models. Stored in the repo-root .env and applied right away — no restart.',
  },
  {
    id: 'selfhosted',
    title: 'Self-hosted vLLM',
    blurb:
      'Endpoints for your own axes. vLLM API key is auto-issued on first Install. Hugging Face token is yours — create at huggingface.co/settings/tokens.',
  },
  {
    id: 'gpu',
    title: 'GPU host (SSH)',
    blurb: 'Used by Deploy. The private key stays on this machine — only its path is stored.',
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

  // Deploy links here as /settings#HF_TOKEN — jump to and highlight that field.
  useEffect(() => {
    if (!data) return;
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    const frame = requestAnimationFrame(() => {
      setFocusKey(hash);
      const el = document.getElementById(`field-${hash}`);
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      try {
        el.focus();
      } catch {
        /* ignore */
      }
    });
    return () => cancelAnimationFrame(frame);
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

  const currentPathValue = pickerFor
    ? (drafts[pickerFor] ??
        data?.settings.find((s) => s.key === pickerFor)?.effective ??
        '')
    : '';

  return (
    <AppShell module="settings">
      <main className="settings-main">
        <section className="settings-head">
          <h1 className="settings-h1">Settings</h1>
          <p className="settings-lede">
            This workbench runs on your machine, so keys and host details are set here instead of
            hand-editing files. Secrets are written to the gitignored repo-root{' '}
            <code>.env</code> and are never sent back to the browser — you only see whether a value
            is set and its last 4 characters.
          </p>
          {data?.envFile ? (
            <p className="settings-note">
              Writing to <code>{data.envFile}</code>
            </p>
          ) : null}
        </section>

        {error ? <p className="settings-error">{error}</p> : null}
        {message ? <p className="settings-ok">{message}</p> : null}

        {/* Above the saved settings, and outside the save flow: this one lives in the
            browser rather than in .env, and it applies the moment it is clicked. */}
        <section className="settings-card">
          <div className="settings-card-head">
            <h2>Appearance</h2>
            <p>
              Stored in this browser, not in <code>.env</code>, and applied immediately —
              there is nothing to save.
            </p>
          </div>
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
        </section>

        {!data && !error ? <p className="settings-note">Checking saved settings…</p> : null}

        {data ? GROUPS.map((g) => (
          <section key={g.id} className="settings-card">
            <div className="settings-card-head">
              <h2>{g.title}</h2>
              <p>{g.blurb}</p>
            </div>
            <div className="settings-rows">
              {settingsByGroup(g.id).map((s) => {
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
          </section>
        )) : null}

        {data ? <div className="settings-actions">
          <button
            type="button"
            className="settings-save"
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
        </div> : null}
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
