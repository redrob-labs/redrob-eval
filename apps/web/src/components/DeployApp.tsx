'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { DeployTerminal, type DeployTerminalHandle } from '@/components/DeployTerminal';
import { useT } from '@/components/LocaleProvider';
import { hfModelUrl, parseHfRepoId } from '@/lib/deploy/hf';
import { MAX_DEPLOY_SLOTS } from '@/lib/deploy/limits';
import type { MessageKey } from '@/lib/i18n';

type DeployOp =
  | 'install'
  | 'measure'
  | 'measure-all'
  | 'start'
  | 'stop'
  | 'health'
  | 'health-all'
  | 'benchmark'
  | 'undeploy'
  | 'purge';

/** Ops that act on the host rather than on one slot. */
const WHOLE_HOST_OPS = new Set<DeployOp>([
  'install',
  'purge',
  'measure-all',
  'health-all',
]);
type Helper = 'tail' | 'gpu' | 'interrupt';

type SlotView = {
  index: number;
  port: number;
  unit: string;
  active: boolean;
  enabled: boolean;
  measured: boolean;
  unreadable: boolean;
  modelHf: string | null;
  servedName: string;
  tokPerSec: string | null;
  util: string | null;
  precision: string | null;
  paths: {
    measuredEnv: string;
    serveScript: string;
    logFile: string;
  };
  label: string | null;
  hf: string | null;
  reachable: boolean | null;
  reachError: string | null;
  reachKind: 'ok' | 'refused' | 'blocked' | 'wrongModel' | 'unknown';
};

type StatusPayload = {
  env: Record<string, boolean>;
  sshReady: boolean;
  host: string | null;
  installRoot: string;
  port: number;
  portBase: number;
  endpoint: string | null;
  slots: SlotView[];
  remote: Record<string, string> | null;
  remoteError: string | null;
};

type Preset = { key: string; label: string; hfRepoId: string; tier?: 'small' | 'large' };

const STEP_LABEL_KEYS: Record<DeployOp, MessageKey> = {
  install: 'deploy.step.install.title',
  measure: 'deploy.step.measure.title',
  'measure-all': 'deploy.slots.measureAll',
  start: 'deploy.step.serve.title',
  stop: 'deploy.step.serve.stop',
  health: 'deploy.step.verify.health',
  'health-all': 'deploy.slots.healthAll',
  benchmark: 'deploy.step.verify.benchmark',
  undeploy: 'deploy.slot.undeploy',
  purge: 'deploy.purge.title',
};

const DEFAULT_MODEL = 'gemma4-e4b';
const CUSTOM_KEY = '__custom__';
const STORAGE_KEY = 'redrob.deploy.customHf';
const SETTINGS_HF = '/settings#HF_TOKEN';

const SEED_PRESETS: Preset[] = [
  { key: 'gemma4-e4b', label: 'Gemma 4 E4B', hfRepoId: 'google/gemma-4-E4B-it', tier: 'small' },
  { key: 'gemma4-31b', label: 'Gemma 4 31B', hfRepoId: 'google/gemma-4-31B-it', tier: 'large' },
];

function loadCustomRepos(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string' && Boolean(parseHfRepoId(x)));
  } catch {
    return [];
  }
}

function saveCustomRepos(repos: string[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(repos));
  } catch {
    /* ignore */
  }
}

function presetByKey(key: string, options: Preset[]): Preset | undefined {
  return options.find((o) => o.key === key);
}

function explainFetchError(error: unknown, fallback: string, unreachable: string): string {
  if (error instanceof TypeError && /fetch/i.test(error.message)) {
    return unreachable;
  }
  return error instanceof Error ? error.message : fallback;
}

type SlotDraft = {
  modelKey: string;
  hf: string;
};

function defaultDraft(): SlotDraft {
  return {
    modelKey: DEFAULT_MODEL,
    hf: SEED_PRESETS.find((p) => p.key === DEFAULT_MODEL)!.hfRepoId,
  };
}

/** One explanation per cause; the firewall hint is only for a dropped connection. */
const REACH_MESSAGE: Record<SlotView['reachKind'], MessageKey> = {
  ok: 'deploy.slot.portClosed',
  refused: 'deploy.slot.portRefused',
  blocked: 'deploy.slot.portClosed',
  wrongModel: 'deploy.slot.wrongModel',
  unknown: 'deploy.slot.noAnswer',
};

function slotStatusLabel(
  slot: SlotView,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  // Running but not callable from here is its own state: Compare can only offer
  // a slot it can reach, so calling this one "active" would explain nothing.
  if (slot.active && slot.reachable === false) {
    return slot.reachKind === 'refused'
      ? t('deploy.slot.status.starting')
      : t('deploy.slot.status.unreachable');
  }
  if (slot.active) return t('deploy.slot.status.active');
  if (slot.measured) return t('deploy.slot.status.stopped');
  if (slot.unreadable) return t('deploy.slot.status.unreadable');
  return t('deploy.slot.status.notMeasured');
}

export function DeployApp() {
  const t = useT();
  const unreachableMsg = t('deploy.error.unreachable');
  const termRef = useRef<DeployTerminalHandle>(null);
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [presets, setPresets] = useState<Preset[]>(SEED_PRESETS);
  const [customRepos, setCustomRepos] = useState<string[]>([]);
  const [addInput, setAddInput] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingOp, setPendingOp] = useState<DeployOp | null>(null);
  const [pendingSlot, setPendingSlot] = useState<number | null>(null);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  /** Indexes the user has open as cards (union of local registry + defaults). */
  const [openSlots, setOpenSlots] = useState<number[]>([0]);
  const [drafts, setDrafts] = useState<Record<number, SlotDraft>>({ 0: defaultDraft() });
  const [logSlot, setLogSlot] = useState(0);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setCustomRepos(loadCustomRepos()));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/deploy/candidates');
        const body = (await res.json()) as { candidates?: Preset[] };
        if (!cancelled && body.candidates?.length) setPresets(body.candidates);
      } catch {
        /* keep seeds */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const options = useMemo(() => {
    const extras: Preset[] = customRepos
      .filter((r) => !presets.some((p) => p.hfRepoId === r))
      .map((r) => ({ key: `${CUSTOM_KEY}:${r}`, label: r, hfRepoId: r }));
    return [...presets, ...extras];
  }, [customRepos, presets]);

  const modelOptions = useMemo(() => {
    const groups = [
      {
        key: 'small' as const,
        label: t('deploy.group.small'),
        items: options.filter((o) => o.tier === 'small'),
      },
      {
        key: 'large' as const,
        label: t('deploy.group.large'),
        items: options.filter((o) => o.tier === 'large'),
      },
      {
        key: 'custom' as const,
        label: t('deploy.group.custom'),
        items: options.filter((o) => !o.tier),
      },
    ];
    return groups
      .filter((g) => g.items.length > 0)
      .map((g) => (
        <optgroup key={g.key} label={g.label}>
          {g.items.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </optgroup>
      ));
  }, [options, t]);

  const clearPendingOp = useCallback(() => {
    if (pendingTimer.current) clearTimeout(pendingTimer.current);
    pendingTimer.current = null;
    setPendingOp(null);
    setPendingSlot(null);
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/deploy/status', {
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = (await res.json()) as StatusPayload;
      setStatus(payload);
      setStatusError(null);
      if (payload.remote?.RUNNING_OP || payload.remote?.STALE_OP) clearPendingOp();

      // Keep open cards in sync with local registry + remotely measured/active slots.
      const fromRemote = (payload.slots ?? [])
        .filter((s) => s.measured || s.active || s.hf || s.label)
        .map((s) => s.index);
      setOpenSlots((prev) => {
        const next = new Set([...prev, ...fromRemote]);
        if (next.size === 0) next.add(0);
        return [...next].sort((a, b) => a - b);
      });
      setDrafts((prev) => {
        const next = { ...prev };
        for (const s of payload.slots ?? []) {
          if (!s.modelHf && !s.hf) continue;
          const hf = s.hf || s.modelHf!;
          const hit = options.find((o) => o.hfRepoId === hf);
          if (!next[s.index]) {
            next[s.index] = {
              modelKey: hit?.key ?? `${CUSTOM_KEY}:${hf}`,
              hf,
            };
          } else if (!next[s.index]!.hf || next[s.index]!.hf === 'unassigned') {
            next[s.index] = {
              modelKey: hit?.key ?? `${CUSTOM_KEY}:${hf}`,
              hf,
            };
          }
        }
        return next;
      });
    } catch (error) {
      setStatusError(explainFetchError(error, t('deploy.error.gpuStatus'), unreachableMsg));
    }
  }, [clearPendingOp, options, t, unreachableMsg]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => void loadStatus());
    const interval = setInterval(() => void loadStatus(), 8000);
    return () => {
      cancelAnimationFrame(frame);
      clearInterval(interval);
    };
  }, [loadStatus]);

  useEffect(
    () => () => {
      if (pendingTimer.current) clearTimeout(pendingTimer.current);
    },
    [],
  );

  const pickModel = (slotIndex: number, key: string) => {
    const hit = presetByKey(key, options);
    setDrafts((prev) => ({
      ...prev,
      [slotIndex]: {
        modelKey: key,
        hf: hit?.hfRepoId ?? prev[slotIndex]?.hf ?? '',
      },
    }));
  };

  const addFromLink = () => {
    const repo = parseHfRepoId(addInput);
    if (!repo) {
      setAddError(t('deploy.error.pickValidRepos'));
      return;
    }
    setAddError(null);
    const next = customRepos.includes(repo) ? customRepos : [repo, ...customRepos];
    setCustomRepos(next);
    saveCustomRepos(next);
    setAddInput('');
    setNotice(t('deploy.addedRepo', { repo }));
  };

  const ensureShell = async (): Promise<string> => {
    const handle = termRef.current;
    if (!handle) throw new Error(t('deploy.error.terminalNotReady'));
    if (handle.status !== 'open' || !handle.sessionId) {
      await handle.open();
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 50));
        if (termRef.current?.sessionId) return termRef.current.sessionId;
      }
      throw new Error(t('deploy.error.shellNotOpen'));
    }
    return handle.sessionId;
  };

  /** What each open slot is set to serve, for the ops that cover the whole host. */
  const fleetBody = (indexes: number[]) =>
    indexes.map((index) => {
      const draft = drafts[index] ?? defaultDraft();
      const entry: { slot: number; hf?: string; modelKey?: string } = { slot: index };
      const repo = parseHfRepoId(draft.hf);
      if (repo) entry.hf = repo;
      if (draft.modelKey && !draft.modelKey.startsWith(CUSTOM_KEY)) {
        entry.modelKey = draft.modelKey;
      }
      return entry;
    });

  const injectOp = async (op: DeployOp, slotIndex = 0, fleet?: number[]) => {
    const draft = drafts[slotIndex] ?? defaultDraft();
    const repo = parseHfRepoId(draft.hf);
    const needsRepo =
      op !== 'install' &&
      op !== 'undeploy' &&
      op !== 'stop' &&
      op !== 'purge' &&
      op !== 'health-all';
    if (needsRepo && !repo) {
      setNotice(t('deploy.error.pickValidRepos'));
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const id = await ensureShell();
      const body: Record<string, unknown> = { op, slot: slotIndex };
      if (repo) body.hf = repo;
      if (draft.modelKey && !draft.modelKey.startsWith(CUSTOM_KEY)) {
        body.modelKey = draft.modelKey;
      }
      if (fleet?.length) body.slots = fleetBody(fleet);
      const res = await fetch(`/api/deploy/terminal/${id}/inject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as {
        error?: string;
        label?: string;
        servedName?: string;
        port?: number;
      };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      if (pendingTimer.current) clearTimeout(pendingTimer.current);
      setPendingOp(op);
      setPendingSlot(WHOLE_HOST_OPS.has(op) ? null : slotIndex);
      pendingTimer.current = setTimeout(() => clearPendingOp(), 30_000);
      termRef.current?.focus();
      const slotHint =
        op === 'measure-all' || op === 'health-all'
          ? t('deploy.notice.opFleet', {
              op: json.label ?? op,
              slots: (fleet ?? [slotIndex]).join(', '),
            })
          : WHOLE_HOST_OPS.has(op)
            ? t('deploy.notice.opInstall')
            : t('deploy.notice.opSlot', {
              op: json.label ?? op,
              slot: String(slotIndex),
              port: String(json.port ?? (status?.portBase ?? 8000) + slotIndex),
              served: json.servedName ?? `redrob-s${slotIndex}`,
            });
      setNotice(slotHint);
      if (op === 'undeploy') {
        setOpenSlots((prev) => {
          const next = prev.filter((i) => i !== slotIndex);
          return next.length ? next : [0];
        });
      }
      void loadStatus();
    } catch (e) {
      clearPendingOp();
      setNotice(explainFetchError(e, t('deploy.error.stepFailed'), unreachableMsg));
    } finally {
      setBusy(false);
    }
  };

  const injectHelper = async (helper: Helper) => {
    setBusy(true);
    try {
      const id = await ensureShell();
      const res = await fetch(`/api/deploy/terminal/${id}/inject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ helper, slot: logSlot }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      termRef.current?.focus();
    } catch (e) {
      setNotice(explainFetchError(e, t('deploy.error.helperFailed'), unreachableMsg));
    } finally {
      setBusy(false);
    }
  };

  const cancelOp = async () => {
    setCancelling(true);
    try {
      const res = await fetch('/api/deploy/cancel', { method: 'POST' });
      const json = (await res.json().catch(() => ({}))) as { error?: string; killed?: boolean };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      clearPendingOp();
      setNotice(json.killed ? t('deploy.notice.cancelled') : t('deploy.notice.cancelNothing'));
      await loadStatus();
    } catch (e) {
      setNotice(explainFetchError(e, t('deploy.error.cancelFailed'), unreachableMsg));
    } finally {
      setCancelling(false);
    }
  };

  /** Every slot and the downloaded weights, behind a confirm: it is not undoable. */
  const purgeAll = async () => {
    if (typeof window !== 'undefined' && !window.confirm(t('deploy.purge.confirm'))) {
      return;
    }
    await injectOp('purge');
    setOpenSlots([0]);
  };

  const addSlot = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch('/api/deploy/slots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allocate: true, hf: defaultDraft().hf }),
      });
      const json = (await res.json()) as {
        error?: string;
        slot?: { index: number; hf: string };
      };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      const index = json.slot?.index;
      if (index === undefined) throw new Error(t('deploy.error.stepFailed'));
      setOpenSlots((prev) => [...new Set([...prev, index])].sort((a, b) => a - b));
      setDrafts((prev) => ({
        ...prev,
        [index]: {
          modelKey: DEFAULT_MODEL,
          hf: json.slot?.hf || defaultDraft().hf,
        },
      }));
      setNotice(t('deploy.slot.added', { slot: String(index) }));
      void loadStatus();
    } catch (e) {
      setNotice(explainFetchError(e, t('deploy.error.stepFailed'), unreachableMsg));
    } finally {
      setBusy(false);
    }
  };

  const env = status?.env ?? {};
  const statusReady = status !== null;
  const sshReady = status?.sshReady ?? false;
  const remote = status?.remote ?? null;
  const installed = remote?.VLLM_INSTALLED === '1';
  const hasToken = Boolean(env.HF_TOKEN);
  const runningOp = (remote?.RUNNING_OP?.trim() || null) as DeployOp | null;
  const staleOp = (remote?.STALE_OP?.trim() || null) as DeployOp | null;
  const tmuxMissing = remote?.TMUX_PRESENT === '0';
  const activeOp = runningOp ?? pendingOp;
  const host = status?.host ?? null;
  const installRoot = status?.installRoot ?? '/opt/redrob-vllm';
  const portBase = status?.portBase ?? status?.port ?? 8000;
  const slotViews = status?.slots ?? [];
  const freeIndexes = Array.from({ length: MAX_DEPLOY_SLOTS }, (_, i) => i).filter(
    (i) => !openSlots.includes(i),
  );
  /** Only a slot that is up can be health-checked; a stopped one not answering is not news. */
  const servingSlots = slotViews.filter((s) => s.active).map((s) => s.index);
  const canAddSlot = freeIndexes.length > 0 && openSlots.length < MAX_DEPLOY_SLOTS;

  return (
    <AppShell
      module="deploy"
      right={
        <span className="app-muted">
          {statusError && !statusReady
            ? t('deploy.status.unavailable')
            : !statusReady
              ? t('deploy.status.checking')
              : sshReady
                ? t('deploy.status.configured')
                : t('deploy.status.notSet')}
        </span>
      }
    >
      <main className="deploy-shell-layout">
        <section className="deploy-toolbar">
          <div className="deploy-toolbar-top">
            <div>
              <h1 className="deploy-h1">{t('deploy.title')}</h1>
              <p className="deploy-lede">{t('deploy.lede')}</p>
            </div>

            <div className="deploy-host-banner">
              <p className="deploy-host-banner-title">{t('deploy.host.title')}</p>
              <dl className="deploy-host-facts">
                <div>
                  <dt>GPU_HOST</dt>
                  <dd>
                    {host ? (
                      host
                    ) : (
                      <>
                        {t('deploy.host.notConfigured')}{' '}
                        <Link href="/settings">{t('deploy.openSettings')}</Link>
                      </>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{t('deploy.host.installRoot')}</dt>
                  <dd>
                    <code>{installRoot}</code>
                  </dd>
                </div>
                <div>
                  <dt>{t('deploy.host.secrets')}</dt>
                  <dd>
                    <code>/etc/redrob-vllm/secrets.env</code>
                  </dd>
                </div>
                <div>
                  <dt>{t('deploy.host.ports')}</dt>
                  <dd>
                    {t('deploy.host.portsHint', {
                      base: String(portBase),
                      last: String(portBase + MAX_DEPLOY_SLOTS - 1),
                    })}
                  </dd>
                </div>
              </dl>
            </div>

            {!statusReady && !statusError ? (
              <p className="deploy-callout">{t('deploy.checkingKeys')}</p>
            ) : null}
            {statusReady && !sshReady ? (
              <p className="deploy-callout">
                {t('deploy.setHostFirst')} <Link href="/settings">{t('deploy.openSettings')}</Link>
              </p>
            ) : null}
            {statusReady && sshReady && !hasToken ? (
              <p className="deploy-callout">
                {t('deploy.needsToken')} <Link href={SETTINGS_HF}>{t('deploy.setHfToken')}</Link>
              </p>
            ) : null}
            {activeOp ? (
              <p className="deploy-callout">
                {pendingSlot !== null
                  ? t('deploy.runningOnHostSlot', {
                      step: t(STEP_LABEL_KEYS[activeOp]),
                      slot: String(pendingSlot),
                    })
                  : t('deploy.runningOnHost', { step: t(STEP_LABEL_KEYS[activeOp]) })}{' '}
                <button
                  type="button"
                  className="deploy-callout-action"
                  onClick={() => void cancelOp()}
                  disabled={cancelling}
                >
                  {cancelling ? t('deploy.stopping') : t('deploy.stopOp')}
                </button>
              </p>
            ) : null}
            {staleOp ? (
              <p className="deploy-callout is-error">
                {t('deploy.staleOp', {
                  step: staleOp in STEP_LABEL_KEYS ? t(STEP_LABEL_KEYS[staleOp]) : staleOp,
                })}
              </p>
            ) : null}
            {statusReady && sshReady && tmuxMissing ? (
              <p className="deploy-callout">{t('deploy.tmuxMissing')}</p>
            ) : null}
            {statusError ? (
              <p className="deploy-callout is-error">
                {t('deploy.statusFailed', { error: statusError })}
              </p>
            ) : null}
            {status?.remoteError ? (
              <p className="deploy-callout is-error">
                {t('deploy.hostUnreachable', { error: status.remoteError })}
              </p>
            ) : null}
          </div>

          <div className="deploy-section">
            <h2>{t('deploy.step.install.title')}</h2>
            <p className="deploy-hint">{t('deploy.step.install.desc')}</p>
            <div className="deploy-step-actions">
              <button
                type="button"
                className={installed ? 'deploy-op-btn' : 'deploy-op-btn is-primary'}
                onClick={() => void injectOp('install', 0)}
                disabled={
                  !statusReady ||
                  !sshReady ||
                  !hasToken ||
                  busy ||
                  activeOp !== null
                }
              >
                {installed
                  ? t('deploy.step.install.reinstall')
                  : t('deploy.step.install.install')}
              </button>
              <button
                type="button"
                className="deploy-op-btn is-danger"
                onClick={() => void purgeAll()}
                disabled={busy || !sshReady || activeOp !== null}
                title={t('deploy.purge.hint')}
              >
                {t('deploy.purge.title')}
              </button>
            </div>
          </div>

          <div className="deploy-section">
            <div className="deploy-section-head">
              <h2>{t('deploy.slots.title')}</h2>
              <button
                type="button"
                className="deploy-op-btn"
                onClick={() => void addSlot()}
                disabled={!canAddSlot || busy || !sshReady}
                title={
                  canAddSlot
                    ? t('deploy.slot.addHint')
                    : t('deploy.slot.addDisabled', { max: String(MAX_DEPLOY_SLOTS) })
                }
              >
                {t('deploy.slot.add')}
              </button>
            </div>
            <p className="deploy-hint">
              {t('deploy.slots.hint', { max: String(MAX_DEPLOY_SLOTS) })}
            </p>

            <div className="deploy-step-actions">
              <button
                type="button"
                className="deploy-op-btn"
                onClick={() => void injectOp('measure-all', openSlots[0] ?? 0, openSlots)}
                disabled={
                  !statusReady ||
                  !sshReady ||
                  !hasToken ||
                  !installed ||
                  busy ||
                  activeOp !== null ||
                  openSlots.length === 0
                }
                title={t('deploy.slots.measureAllHint')}
              >
                {t('deploy.slots.measureAll', { count: String(openSlots.length) })}
              </button>
              <button
                type="button"
                className="deploy-op-btn"
                onClick={() => void injectOp('health-all', servingSlots[0] ?? 0, servingSlots)}
                disabled={
                  busy || activeOp !== null || !sshReady || servingSlots.length === 0
                }
                title={t('deploy.slots.healthAllHint')}
              >
                {t('deploy.slots.healthAll', { count: String(servingSlots.length) })}
              </button>
            </div>
            <p className="deploy-hint">{t('deploy.slots.measureAllWhy')}</p>

            <div className="deploy-add-hf-row" style={{ marginBottom: 12 }}>
              <input
                type="url"
                className="deploy-hf-input"
                value={addInput}
                disabled={busy}
                placeholder={t('deploy.addFromLink')}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => {
                  setAddInput(e.target.value);
                  setAddError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addFromLink();
                  }
                }}
              />
              <button
                type="button"
                className="deploy-op-btn"
                onClick={addFromLink}
                disabled={busy || !addInput.trim()}
              >
                {t('deploy.add')}
              </button>
            </div>
            {addError ? <p className="deploy-error">{addError}</p> : null}

            <div className="deploy-slot-list">
              {openSlots.map((index) => {
                const view = slotViews.find((s) => s.index === index);
                const draft = drafts[index] ?? defaultDraft();
                const port = view?.port ?? portBase + index;
                const unit = view?.unit ?? `redrob-vllm-s${index}.service`;
                const served = view?.servedName ?? `redrob-s${index}`;
                const measured = view?.measured ?? false;
                const running = view?.active ?? false;
                const blockedInstall = !installed
                  ? t('deploy.step.measure.blockedRunInstall')
                  : null;
                const unreadable = view?.unreadable ?? false;
                const blockedMeasure = measured
                  ? null
                  : unreadable
                    ? t('deploy.slot.unreadable')
                    : t('deploy.step.serve.blockedRunMeasure');
                const blockedRun = !running
                  ? t('deploy.step.verify.blockedRunning')
                  : null;
                const slotBusy = busy || activeOp !== null || !statusReady || !sshReady;

                return (
                  <article key={index} className="deploy-slot-card">
                    <header className="deploy-slot-card-head">
                      <div>
                        <h3>
                          {t('deploy.slot.heading', { slot: String(index) })}
                          <span className="deploy-slot-status">
                            {' '}
                            · {view ? slotStatusLabel(view, t) : t('deploy.slot.status.notMeasured')}
                          </span>
                        </h3>
                        <p className="deploy-slot-meta">
                          <code>:{port}</code> · <code>{unit}</code> · <code>{served}</code>
                        </p>
                      </div>
                    </header>

                    <label className="deploy-field">
                      <span>{t('deploy.modelOne')}</span>
                      <select
                        value={draft.modelKey}
                        onChange={(e) => pickModel(index, e.target.value)}
                        disabled={busy}
                      >
                        {modelOptions}
                      </select>
                      <a
                        className="deploy-hf-link"
                        href={hfModelUrl(draft.hf)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {draft.hf}
                      </a>
                    </label>

                    <dl className="deploy-slot-paths">
                      <div>
                        <dt>{t('deploy.slot.path.measured')}</dt>
                        <dd>
                          <code>
                            {view?.paths.measuredEnv ??
                              `/etc/redrob-vllm/slots/${index}/measured.env`}
                          </code>
                        </dd>
                      </div>
                      <div>
                        <dt>{t('deploy.slot.path.log')}</dt>
                        <dd>
                          <code>
                            {view?.paths.logFile ?? `/var/log/redrob-vllm/serve-${index}.log`}
                          </code>
                        </dd>
                      </div>
                      {view?.util ? (
                        <div>
                          <dt>{t('deploy.facts.measured')}</dt>
                          <dd>
                            util {view.util}
                            {view.precision ? ` · ${view.precision}` : ''}
                            {view.tokPerSec ? ` · ${view.tokPerSec} tok/s` : ''}
                          </dd>
                        </div>
                      ) : null}
                      {view?.modelHf ? (
                        <div>
                          <dt>{t('deploy.facts.model')}</dt>
                          <dd>
                            {view.modelHf}
                            {view.servedName ? ` → ${view.servedName}` : ''}
                          </dd>
                        </div>
                      ) : null}
                    </dl>

                    {unreadable ? (
                      <p className="deploy-error">{t('deploy.slot.unreadable')}</p>
                    ) : null}

                    {view?.active && view.reachable === false ? (
                      <p className="deploy-error">
                        {t(REACH_MESSAGE[view.reachKind], {
                          port: String(port),
                          reason: view.reachError ?? '',
                          servedName: view.servedName,
                          log: view.paths.logFile,
                        })}
                      </p>
                    ) : null}

                    <div className="deploy-slot-actions">
                      <button
                        type="button"
                        className={
                          measured ? 'deploy-op-btn' : 'deploy-op-btn is-primary'
                        }
                        disabled={slotBusy || Boolean(blockedInstall) || !hasToken}
                        title={blockedInstall ?? undefined}
                        onClick={() => void injectOp('measure', index)}
                      >
                        {measured
                          ? t('deploy.step.measure.remeasure')
                          : t('deploy.step.measure.measure')}
                      </button>
                      <button
                        type="button"
                        className={
                          running ? 'deploy-op-btn' : 'deploy-op-btn is-primary'
                        }
                        disabled={slotBusy || Boolean(blockedMeasure)}
                        title={blockedMeasure ?? undefined}
                        onClick={() => void injectOp('start', index)}
                      >
                        {running
                          ? t('deploy.step.serve.restart')
                          : t('deploy.step.serve.start')}
                      </button>
                      <button
                        type="button"
                        className="deploy-op-btn"
                        disabled={slotBusy}
                        onClick={() => void injectOp('stop', index)}
                      >
                        {t('deploy.step.serve.stop')}
                      </button>
                      <button
                        type="button"
                        className="deploy-op-btn"
                        disabled={slotBusy || Boolean(blockedRun)}
                        title={blockedRun ?? undefined}
                        onClick={() => void injectOp('health', index)}
                      >
                        {t('deploy.step.verify.health')}
                      </button>
                      <button
                        type="button"
                        className="deploy-op-btn"
                        disabled={slotBusy || Boolean(blockedRun)}
                        title={blockedRun ?? undefined}
                        onClick={() => void injectOp('benchmark', index)}
                      >
                        {t('deploy.step.verify.benchmark')}
                      </button>
                      <button
                        type="button"
                        className="deploy-op-btn is-danger"
                        disabled={slotBusy}
                        onClick={() => void injectOp('undeploy', index)}
                      >
                        {t('deploy.slot.undeploy')}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>

          <div className="deploy-section">
            <h2>{t('deploy.shell')}</h2>
            <div className="deploy-ops">
              <label className="deploy-field" style={{ minWidth: 120 }}>
                <span>{t('deploy.shell.logSlot')}</span>
                <select
                  value={logSlot}
                  onChange={(e) => setLogSlot(Number(e.target.value))}
                  disabled={!sshReady}
                >
                  {openSlots.map((i) => (
                    <option key={i} value={i}>
                      {t('deploy.slot.heading', { slot: String(i) })}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="app-ghost-btn"
                onClick={() => void injectHelper('interrupt')}
                disabled={!sshReady}
              >
                {t('deploy.ctrlC')}
              </button>
              <button
                type="button"
                className="app-ghost-btn"
                onClick={() => void injectHelper('tail')}
                disabled={!sshReady}
              >
                {t('deploy.serveLog')}
              </button>
              <button
                type="button"
                className="app-ghost-btn"
                onClick={() => void injectHelper('gpu')}
                disabled={!sshReady}
              >
                {t('deploy.nvidiaSmi')}
              </button>
            </div>
          </div>

          {notice ? <p className="deploy-notice">{notice}</p> : null}

          {remote ? (
            <dl className="deploy-facts">
              <div>
                <dt>{t('deploy.facts.gpu')}</dt>
                <dd>
                  {remote.GPU_NAME ?? t('deploy.facts.unknown')}
                  {remote.GPU_FREE_MIB ? ` · ${remote.GPU_FREE_MIB} MiB free` : ''}
                </dd>
              </div>
              <div>
                <dt>{t('deploy.facts.endpoint')}</dt>
                <dd>{status?.endpoint ?? t('deploy.facts.unknown')}</dd>
              </div>
            </dl>
          ) : null}
        </section>

        <DeployTerminal
          ref={termRef}
          sshReady={sshReady}
          autoOpen
          onOpened={() => void loadStatus()}
        />
      </main>
    </AppShell>
  );
}
