'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/components/LocaleProvider';
import { cn } from '@/lib/utils';

/**
 * Mirrors VllmHostView from the store. Declared again rather than imported,
 * because that module reaches for node:fs and must not enter a client bundle.
 */
export type VllmHost = {
  id: string;
  label: string;
  baseUrl: string;
  source: 'builtin' | 'custom';
  editable: boolean;
  envKey: string | null;
  hasOwnKey: boolean;
  keyHint: string | null;
};

type ProbeState = {
  reachable: boolean;
  baseUrl: string;
  error: string | null;
  servedModels: string[];
};

type Draft = { label: string; baseUrl: string; apiKey: string };

const EMPTY_DRAFT: Draft = { label: '', baseUrl: '', apiKey: '' };

/**
 * The vLLM endpoints this workbench can call.
 *
 * Saves immediately per host rather than joining the section's Save button,
 * which batches env fields. Mixing the two would make one Save mean two things.
 */
export function VllmHostsPanel() {
  const t = useT();
  const [hosts, setHosts] = useState<VllmHost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, ProbeState | 'checking'>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [adding, setAdding] = useState(false);
  const [newHost, setNewHost] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/vllm-hosts');
      const body = (await res.json()) as { hosts?: VllmHost[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setHosts(body.hosts ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.hosts.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const probe = useCallback(async (id: string) => {
    setProbes((prev) => ({ ...prev, [id]: 'checking' }));
    try {
      const res = await fetch(`/api/vllm-hosts/${encodeURIComponent(id)}/probe`);
      const body = (await res.json()) as ProbeState & { error?: string };
      setProbes((prev) => ({
        ...prev,
        [id]: {
          reachable: Boolean(body.reachable),
          baseUrl: body.baseUrl,
          error: body.error ?? null,
          servedModels: body.servedModels ?? [],
        },
      }));
    } catch (e) {
      setProbes((prev) => ({
        ...prev,
        [id]: {
          reachable: false,
          baseUrl: '',
          error: e instanceof Error ? e.message : 'probe failed',
          servedModels: [],
        },
      }));
    }
  }, []);

  const mutate = useCallback(
    async (input: RequestInfo, init: RequestInit) => {
      setBusy(true);
      try {
        const res = await fetch(input, init);
        const body = (await res.json()) as { hosts?: VllmHost[]; error?: string };
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setHosts(body.hosts ?? []);
        setError(null);
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : t('settings.hosts.saveFailed'));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  const label = (host: VllmHost): string =>
    host.id === 'builtin' ? t('settings.hosts.builtin') : host.label;

  return (
    <div className="settings-hosts">
      <div className="settings-hosts-head">
        <div>
          <span className="settings-label-main">{t('settings.hosts.title')}</span>
          <span className="settings-hint">{t('settings.hosts.blurb')}</span>
        </div>
        <button
          type="button"
          className="app-ghost-btn"
          onClick={() => {
            setAdding((open) => !open);
            setNewHost(EMPTY_DRAFT);
          }}
        >
          {adding ? t('common.cancel') : t('settings.hosts.add')}
        </button>
      </div>

      {error ? <p className="settings-error">{error}</p> : null}
      {loading ? <p className="settings-note">{t('settings.checking')}</p> : null}

      <ul className="settings-host-list">
        {hosts.map((host) => {
          const state = probes[host.id];
          const isEditing = editing === host.id;
          return (
            <li key={host.id} className="settings-host">
              <div className="settings-host-main">
                <span className="settings-label-main">
                  {label(host)}
                  <span
                    className={cn(
                      'settings-dot',
                      state && state !== 'checking' && (state.reachable ? 'on' : 'off'),
                    )}
                    aria-hidden
                  />
                  {host.source === 'builtin' ? (
                    <span className="settings-default-tag">
                      {t('settings.hosts.builtinTag')}
                    </span>
                  ) : null}
                </span>
                <code className="settings-key">{host.baseUrl}</code>
                <span className="settings-hint">
                  {state === 'checking'
                    ? t('settings.hosts.checking')
                    : state
                      ? state.reachable
                        ? t('settings.hosts.up', {
                            list: state.servedModels.join(', ') || '-',
                          })
                        : t('settings.hosts.down', { error: state.error ?? '' })
                      : host.envKey
                        ? t('settings.hosts.fromEnv', { key: host.envKey })
                        : host.hasOwnKey
                          ? t('settings.hosts.ownKey', { hint: host.keyHint ?? '' })
                          : t('settings.hosts.sharedKey')}
                </span>
              </div>

              <div className="settings-host-actions">
                <button
                  type="button"
                  className="app-ghost-btn"
                  disabled={state === 'checking'}
                  onClick={() => void probe(host.id)}
                >
                  {t('settings.hosts.test')}
                </button>
                {host.editable ? (
                  <>
                    <button
                      type="button"
                      className="app-ghost-btn"
                      onClick={() => {
                        setEditing(isEditing ? null : host.id);
                        setDraft({ label: host.label, baseUrl: host.baseUrl, apiKey: '' });
                      }}
                    >
                      {isEditing ? t('common.cancel') : t('common.edit')}
                    </button>
                    <button
                      type="button"
                      className="app-ghost-btn"
                      disabled={busy}
                      onClick={() => {
                        void mutate(`/api/vllm-hosts/${encodeURIComponent(host.id)}`, {
                          method: 'DELETE',
                        });
                      }}
                    >
                      {t('common.remove')}
                    </button>
                  </>
                ) : null}
              </div>

              {isEditing ? (
                <div className="settings-host-form">
                  <label className="field">
                    <span>{t('settings.hosts.name')}</span>
                    <input
                      type="text"
                      value={draft.label}
                      onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>{t('settings.hosts.baseUrl')}</span>
                    <input
                      type="text"
                      value={draft.baseUrl}
                      spellCheck={false}
                      onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>{t('settings.hosts.apiKey')}</span>
                    <input
                      type="password"
                      value={draft.apiKey}
                      autoComplete="off"
                      placeholder={
                        host.hasOwnKey
                          ? t('settings.hosts.keyStored', { hint: host.keyHint ?? '' })
                          : t('settings.hosts.keyPlaceholder')
                      }
                      onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                    />
                  </label>
                  <div className="settings-host-form-actions">
                    <button
                      type="button"
                      className="app-run-btn"
                      disabled={busy}
                      onClick={() => {
                        void (async () => {
                          const ok = await mutate(
                            `/api/vllm-hosts/${encodeURIComponent(host.id)}`,
                            {
                              method: 'PATCH',
                              headers: { 'Content-Type': 'application/json' },
                              // apiKey is only sent when typed, so an untouched
                              // field never wipes the stored key.
                              body: JSON.stringify(
                                draft.apiKey
                                  ? draft
                                  : { label: draft.label, baseUrl: draft.baseUrl },
                              ),
                            },
                          );
                          if (ok) setEditing(null);
                        })();
                      }}
                    >
                      {t('common.saveChanges')}
                    </button>
                    {host.hasOwnKey ? (
                      <button
                        type="button"
                        className="app-ghost-btn"
                        disabled={busy}
                        onClick={() => {
                          void mutate(`/api/vllm-hosts/${encodeURIComponent(host.id)}`, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ apiKey: '' }),
                          });
                        }}
                      >
                        {t('settings.hosts.clearKey')}
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {adding ? (
        <div className="settings-host-form">
          <label className="field">
            <span>{t('settings.hosts.name')}</span>
            <input
              type="text"
              value={newHost.label}
              placeholder={t('settings.hosts.namePlaceholder')}
              onChange={(e) => setNewHost({ ...newHost, label: e.target.value })}
            />
          </label>
          <label className="field">
            <span>{t('settings.hosts.baseUrl')}</span>
            <input
              type="text"
              value={newHost.baseUrl}
              placeholder="http://127.0.0.1:8000/v1"
              spellCheck={false}
              onChange={(e) => setNewHost({ ...newHost, baseUrl: e.target.value })}
            />
          </label>
          <label className="field">
            <span>{t('settings.hosts.apiKey')}</span>
            <input
              type="password"
              value={newHost.apiKey}
              autoComplete="off"
              placeholder={t('settings.hosts.keyPlaceholder')}
              onChange={(e) => setNewHost({ ...newHost, apiKey: e.target.value })}
            />
          </label>
          <p className="settings-hint">{t('settings.hosts.addHint')}</p>
          <div className="settings-host-form-actions">
            <button
              type="button"
              className="app-run-btn"
              disabled={busy || !newHost.label.trim() || !newHost.baseUrl.trim()}
              onClick={() => {
                void (async () => {
                  const ok = await mutate('/api/vllm-hosts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(newHost),
                  });
                  if (ok) {
                    setAdding(false);
                    setNewHost(EMPTY_DRAFT);
                  }
                })();
              }}
            >
              {busy ? t('common.saving') : t('settings.hosts.save')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
