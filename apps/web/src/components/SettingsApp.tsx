'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { FilePickerModal } from '@/components/FilePickerModal';
import { LocaleSwitch } from '@/components/LocaleSwitch';
import { useT } from '@/components/LocaleProvider';
import { ThemeSwitch } from '@/components/ThemeSwitch';
import { VllmHostsPanel } from '@/components/VllmHostsPanel';
import { en, type MessageKey } from '@/lib/i18n';

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

const SECTION_IDS: SectionId[] = ['appearance', 'providers', 'selfhosted', 'gpu'];

const SECTION_KEYS: Record<
  SectionId,
  { title: MessageKey; blurb: MessageKey; summary: MessageKey }
> = {
  appearance: {
    title: 'settings.sections.appearance.title',
    blurb: 'settings.sections.appearance.blurb',
    summary: 'settings.sections.appearance.summary',
  },
  providers: {
    title: 'settings.sections.providers.title',
    blurb: 'settings.sections.providers.blurb',
    summary: 'settings.sections.providers.summary',
  },
  selfhosted: {
    title: 'settings.sections.selfhosted.title',
    blurb: 'settings.sections.selfhosted.blurb',
    summary: 'settings.sections.selfhosted.summary',
  },
  gpu: {
    title: 'settings.sections.gpu.title',
    blurb: 'settings.sections.gpu.blurb',
    summary: 'settings.sections.gpu.summary',
  },
};

const HF_TOKEN_URL = 'https://huggingface.co/settings/tokens';

/** True when `key` has a translation, so a dynamic field key can opt in without a lookup throwing. */
function hasMsg(key: string): key is MessageKey {
  return key in en;
}

type T = ReturnType<typeof useT>;

/** Field label from `settings.fields.<KEY>.label` when translated, else the API's own label. */
function fieldLabel(t: T, key: string, fallback: string): string {
  const msgKey = `settings.fields.${key}.label`;
  return hasMsg(msgKey) ? t(msgKey) : fallback;
}

/** Same as {@link fieldLabel}, for the optional hint text. */
function fieldHint(t: T, key: string, fallback: string | undefined): string | undefined {
  const msgKey = `settings.fields.${key}.hint`;
  if (hasMsg(msgKey)) return t(msgKey);
  return fallback;
}

export function SettingsApp() {
  const t = useT();
  const [data, setData] = useState<Payload | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [section, setSection] = useState<SectionId>('providers');

  const sections = useMemo(
    () =>
      SECTION_IDS.map((id) => ({
        id,
        title: t(SECTION_KEYS[id].title),
        blurb: t(SECTION_KEYS[id].blurb),
        summary: t(SECTION_KEYS[id].summary),
      })),
    [t],
  );

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
      setError(t('settings.loadFailed'));
    }
  }, [t]);

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
        setError(json.error ?? t('settings.saveFailed'));
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
      setMessage(t('settings.savedMessage', { count: json.applied?.length ?? 0 }));
    } catch {
      setError(t('settings.saveFailed'));
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

  const active = sections.find((s) => s.id === section) ?? sections[0]!;

  const currentPathValue = pickerFor
    ? (drafts[pickerFor] ??
        data?.settings.find((s) => s.key === pickerFor)?.effective ??
        '')
    : '';

  return (
    <AppShell module="settings">
      <main className="settings-layout">
        <aside className="settings-nav" aria-label={t('settings.navAria')}>
          <div className="settings-nav-head">
            <h1 className="settings-h1">{t('settings.title')}</h1>
            <p className="settings-lede">{t('settings.lede')}</p>
          </div>

          <ul className="settings-nav-list">
            {sections.map((s) => {
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
                        <span className="settings-nav-dot" title={t('settings.unsavedDot')} />
                      ) : null}
                    </span>
                    <span className="settings-nav-sub">
                      {counts
                        ? t('settings.fields.setCount', { set: counts.set, total: counts.total })
                        : s.summary}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {data?.envFile ? (
            <p className="settings-note">{t('settings.writingTo', { file: data.envFile })}</p>
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
                  <span className="settings-label-main">{t('settings.colourTheme')}</span>
                  <span className="settings-hint">{t('settings.colourThemeHint')}</span>
                </label>
                <ThemeSwitch />
              </div>
              <div className="settings-row">
                <label className="settings-label">
                  <span className="settings-label-main">{t('settings.language.label')}</span>
                  <span className="settings-hint">{t('settings.language.hint')}</span>
                </label>
                <LocaleSwitch />
              </div>
            </div>
          ) : null}

          {section === 'selfhosted' ? <VllmHostsPanel /> : null}

          {section !== 'appearance' && !data && !error ? (
            <p className="settings-note">{t('settings.checking')}</p>
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
                const label = fieldLabel(t, s.key, s.label);
                const hint = fieldHint(t, s.key, s.hint);
                return (
                  <div
                    key={s.key}
                    className={`settings-row${focusKey === s.key ? ' is-focus' : ''}`}
                  >
                    <label className="settings-label" htmlFor={`field-${s.key}`}>
                      <span className="settings-label-main">
                        {label}
                        <span
                          className={`settings-dot ${s.set || (hasDraft && draft !== '') ? 'on' : 'off'}`}
                          aria-hidden
                        />
                        {usingDefault ? (
                          <span className="settings-default-tag">{t('settings.default')}</span>
                        ) : null}
                      </span>
                      <code className="settings-key">{s.key}</code>
                      {hint ? <span className="settings-hint">{hint}</span> : null}
                      {s.key === 'HF_TOKEN' ? (
                        <a
                          className="settings-hint-link"
                          href={HF_TOKEN_URL}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {t('settings.openHfTokens')}
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
                            ? t('settings.setToReplace', { value: s.value ?? '' })
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
                          {t('common.browse')}
                        </button>
                      ) : null}
                      {s.set || (hasDraft && draft !== '') ? (
                        <button
                          type="button"
                          className="app-ghost-btn"
                          onClick={() => clearValue(s.key)}
                          title={
                            s.defaultValue
                              ? t('settings.clearDefault')
                              : t('settings.clearValue')
                          }
                        >
                          {t('common.clear')}
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
                {saving
                  ? t('common.saving')
                  : dirty
                    ? t('common.saveChanges')
                    : t('common.noChanges')}
              </button>
              {dirty ? (
                <button type="button" className="app-ghost-btn" onClick={() => setDrafts({})}>
                  {t('common.discard')}
                </button>
              ) : null}
              {draftsElsewhere > 0 ? (
                <span className="settings-hint">
                  {t('settings.unsavedElsewhere', { count: draftsElsewhere })}
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
