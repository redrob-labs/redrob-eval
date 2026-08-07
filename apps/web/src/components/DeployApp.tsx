'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { DeployTerminal, type DeployTerminalHandle } from '@/components/DeployTerminal';
import { hfModelUrl, parseHfRepoId } from '@/lib/deploy/hf';

type DeployOp = 'install' | 'measure' | 'start' | 'stop' | 'health' | 'benchmark';
type Helper = 'tail-s' | 'tail-l' | 'gpu' | 'interrupt';

type StatusPayload = {
  env: Record<string, boolean>;
  sshReady: boolean;
  tunnel: { active: boolean; localSPort: number | null; localLPort: number | null };
  remote: Record<string, string> | null;
  remoteError: string | null;
};

type Preset = { key: string; label: string; hfRepoId: string };

/** Shared catalog — both ports pick from the same list. */
const PRESETS: Preset[] = [
  { key: 'gemma4-e4b', label: 'Gemma 4 E4B', hfRepoId: 'google/gemma-4-E4B-it' },
  { key: 'gemma4-31b', label: 'Gemma 4 31B', hfRepoId: 'google/gemma-4-31B-it' },
  { key: 'qwen36-27b', label: 'Qwen3.6 27B', hfRepoId: 'Qwen/Qwen3.6-27B' },
  { key: 'gemma4-26b-a4b', label: 'Gemma 4 26B A4B', hfRepoId: 'google/gemma-4-26B-A4B-it' },
  { key: 'qwen36-35b-a3b', label: 'Qwen3.6 35B-A3B', hfRepoId: 'Qwen/Qwen3.6-35B-A3B' },
  { key: 'gpt-oss-120b', label: 'gpt-oss-120b', hfRepoId: 'openai/gpt-oss-120b' },
];

/** Display names for the op the host reports as in flight. */
const STEP_LABELS: Record<DeployOp, string> = {
  install: 'Install',
  measure: 'Measure',
  start: 'Serve',
  stop: 'Stop',
  health: 'Health',
  benchmark: 'Benchmark',
};

const DEFAULT_A = 'gemma4-e4b';
const DEFAULT_B = 'gemma4-31b';
const CUSTOM_KEY = '__custom__';
const STORAGE_KEY = 'redrob.deploy.customHf';
const SETTINGS_HF = '/settings#HF_TOKEN';

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

function explainFetchError(error: unknown, fallback: string): string {
  if (error instanceof TypeError && /fetch/i.test(error.message)) {
    return 'Could not reach the workbench server. Check that the dev server is running, then retry.';
  }
  return error instanceof Error ? error.message : fallback;
}

export function DeployApp() {
  const termRef = useRef<DeployTerminalHandle>(null);
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [keyA, setKeyA] = useState(DEFAULT_A);
  const [keyB, setKeyB] = useState(DEFAULT_B);
  const [hfA, setHfA] = useState(PRESETS.find((p) => p.key === DEFAULT_A)!.hfRepoId);
  const [hfB, setHfB] = useState(PRESETS.find((p) => p.key === DEFAULT_B)!.hfRepoId);
  const [customRepos, setCustomRepos] = useState<string[]>([]);
  const [addInput, setAddInput] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyTunnel, setBusyTunnel] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setCustomRepos(loadCustomRepos()));
    return () => cancelAnimationFrame(frame);
  }, []);

  const options = useMemo(() => {
    const extras = customRepos
      .filter((r) => !PRESETS.some((p) => p.hfRepoId === r))
      .map((r) => ({ key: `${CUSTOM_KEY}:${r}`, label: r, hfRepoId: r }));
    return [...PRESETS, ...extras];
  }, [customRepos]);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/deploy/status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus((await res.json()) as StatusPayload);
      setStatusError(null);
    } catch (error) {
      setStatusError(explainFetchError(error, 'Could not read GPU host status'));
    }
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(() => void loadStatus());
    const t = setInterval(() => void loadStatus(), 8000);
    return () => {
      cancelAnimationFrame(frame);
      clearInterval(t);
    };
  }, [loadStatus]);

  const pickA = (key: string) => {
    setKeyA(key);
    const hit = presetByKey(key, options);
    if (hit) setHfA(hit.hfRepoId);
  };

  const pickB = (key: string) => {
    setKeyB(key);
    const hit = presetByKey(key, options);
    if (hit) setHfB(hit.hfRepoId);
  };

  const addFromLink = () => {
    const repo = parseHfRepoId(addInput);
    if (!repo) {
      setAddError('Paste a Hugging Face URL or org/model id.');
      return;
    }
    setAddError(null);
    const next = customRepos.includes(repo) ? customRepos : [repo, ...customRepos];
    setCustomRepos(next);
    saveCustomRepos(next);
    const key = `${CUSTOM_KEY}:${repo}`;
    setKeyB(key);
    setHfB(repo);
    setAddInput('');
    setNotice(`Added ${repo}`);
  };

  const ensureShell = async (): Promise<string> => {
    const handle = termRef.current;
    if (!handle) throw new Error('Terminal not ready');
    if (handle.status !== 'open' || !handle.sessionId) {
      await handle.open();
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 50));
        if (termRef.current?.sessionId) return termRef.current.sessionId;
      }
      throw new Error('Shell did not open');
    }
    return handle.sessionId;
  };

  const injectOp = async (op: DeployOp) => {
    const repoA = parseHfRepoId(hfA);
    const repoB = parseHfRepoId(hfB);
    if (!repoA || !repoB) {
      setNotice('Pick a valid Hugging Face repo for both ports.');
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const id = await ensureShell();
      // Backend maps the two slots to axes S/L (= ports 8101/8102).
      const body: Record<string, string> = { op, hfS: repoA, hfL: repoB };
      if (!keyA.startsWith(CUSTOM_KEY)) body.axisS = keyA;
      if (!keyB.startsWith(CUSTOM_KEY)) body.axisL = keyB;
      const res = await fetch(`/api/deploy/terminal/${id}/inject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { error?: string; label?: string };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setNotice(
        `${json.label ?? op} running in the shell — keeps going if you disconnect, Ctrl+C to stop.`,
      );
      termRef.current?.focus();
      void loadStatus();
    } catch (e) {
      setNotice(explainFetchError(e, 'Could not start that step'));
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
        body: JSON.stringify({ helper }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      termRef.current?.focus();
    } catch (e) {
      setNotice(explainFetchError(e, 'Helper failed'));
    } finally {
      setBusy(false);
    }
  };

  const toggleTunnel = async () => {
    setBusyTunnel(true);
    try {
      const res = await fetch('/api/deploy/tunnel', {
        method: status?.tunnel.active ? 'DELETE' : 'POST',
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      await loadStatus();
    } catch (e) {
      setNotice(explainFetchError(e, 'Tunnel failed'));
    } finally {
      setBusyTunnel(false);
    }
  };

  const env = status?.env ?? {};
  const statusReady = status !== null;
  const sshReady = status?.sshReady ?? false;
  const remote = status?.remote ?? null;
  const tunnelOn = status?.tunnel.active ?? false;

  const installed = Boolean(remote && remote.S_ENABLED === 'enabled');
  const measured = remote?.MEASURED_PRESENT === '1';
  const running = remote?.S_ACTIVE === 'active' && remote?.L_ACTIVE === 'active';
  const hasToken = Boolean(env.HF_TOKEN);
  const benchmarked = Boolean(remote?.MEASURED_TOK_PER_SEC_L);
  // A step already running on the host — survives reloads, so offer status not a button.
  const runningOp = (remote?.RUNNING_OP?.trim() || null) as DeployOp | null;
  const tmuxMissing = remote?.TMUX_PRESENT === '0';

  type Action = { label: string; primary?: boolean } & (
    | { op: DeployOp }
    | { op: 'tunnel' }
  );

  type Step = {
    n: number;
    title: string;
    desc: string;
    done: boolean;
    blockedBy: string | null;
    actions: Action[];
  };

  const runAction = (action: Action) => {
    if (action.op === 'tunnel') void toggleTunnel();
    else void injectOp(action.op);
  };

  const steps: Step[] = [
    {
      n: 1,
      title: 'Install',
      desc: 'Creates the redrob-vllm user, venv, systemd units. Safe to re-run.',
      done: installed,
      blockedBy: hasToken ? null : 'Needs HF_TOKEN',
      actions: [{ label: installed ? 'Re-install' : 'Install', op: 'install', primary: !installed }],
    },
    {
      n: 2,
      title: 'Measure',
      desc: 'Loads each model alone to read real VRAM, then writes measured.env. Takes a while.',
      done: measured,
      blockedBy: !hasToken ? 'Needs HF_TOKEN' : installed ? null : 'Run Install first',
      actions: [{ label: measured ? 'Re-measure' : 'Measure', op: 'measure', primary: installed && !measured }],
    },
    {
      n: 3,
      title: 'Serve',
      desc: 'Starts both services on 127.0.0.1:8101 / :8102 (loopback only).',
      done: running,
      blockedBy: measured ? null : 'Run Measure first',
      actions: [
        { label: running ? 'Restart' : 'Start', op: 'start', primary: measured && !running },
        { label: 'Stop', op: 'stop' },
      ],
    },
    {
      n: 4,
      title: 'Tunnel',
      desc: 'Forwards the loopback ports to this machine so Eval can call them.',
      done: tunnelOn,
      blockedBy: null,
      actions: [
        {
          label: tunnelOn ? 'Stop tunnel' : 'Start tunnel',
          op: 'tunnel',
          primary: running && !tunnelOn,
        },
      ],
    },
    {
      n: 5,
      title: 'Verify',
      desc: 'Health checks readiness. Benchmark records tok/s, which sets relative cost in Eval.',
      done: benchmarked,
      blockedBy: running ? null : 'Services are not running',
      actions: [
        { label: 'Health', op: 'health' },
        { label: 'Benchmark', op: 'benchmark', primary: running && !benchmarked },
      ],
    },
  ];

  return (
    <AppShell
      module="deploy"
      right={
        <span className="app-muted">
          {statusError && !statusReady
            ? 'GPU status unavailable'
            : !statusReady
            ? 'Checking GPU configuration…'
            : sshReady
              ? 'GPU host configured'
              : 'GPU host not set'}
        </span>
      }
    >
      <main className="deploy-shell-layout">
        <section className="deploy-toolbar">
          <div className="deploy-toolbar-top">
            <div>
              <h1 className="deploy-h1">Deploy</h1>
              <p className="deploy-lede">
                Two models on one GPU, served on 8101 and 8102. Every step runs in the shell on the
                right, so you can watch it and press Ctrl+C.
              </p>
            </div>

            {!statusReady && !statusError ? (
              <p className="deploy-callout">Checking saved keys and GPU host status…</p>
            ) : null}
            {statusReady && !sshReady ? (
              <p className="deploy-callout">
                Set the GPU host, SSH user and key before anything else.{' '}
                <Link href="/settings">Open Settings</Link>
              </p>
            ) : null}
            {statusReady && sshReady && !hasToken ? (
              <p className="deploy-callout">
                Install and Measure download models on the GPU host, so they need a Hugging Face
                token. <Link href={SETTINGS_HF}>Set HF_TOKEN</Link>
              </p>
            ) : null}
            {runningOp ? (
              <p className="deploy-callout">
                {STEP_LABELS[runningOp]} is running on the GPU host. It keeps going if you close
                this page — come back and the shell reattaches.
              </p>
            ) : null}
            {statusReady && sshReady && tmuxMissing ? (
              <p className="deploy-callout">
                tmux is missing on the GPU host, so a step stops if you disconnect. Install adds it.
              </p>
            ) : null}
            {statusError ? (
              <p className="deploy-callout is-error">Status check failed: {statusError}</p>
            ) : null}
            {status?.remoteError ? (
              <p className="deploy-callout is-error">GPU host unreachable: {status.remoteError}</p>
            ) : null}
          </div>

          <div className="deploy-section">
            <h2>Models</h2>
            <div className="deploy-models">
              <label className="deploy-field">
                <span>Port 8101 · small</span>
                <select value={keyA} onChange={(e) => pickA(e.target.value)} disabled={busy}>
                  {options.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <a className="deploy-hf-link" href={hfModelUrl(hfA)} target="_blank" rel="noreferrer">
                  {hfA}
                </a>
              </label>
              <label className="deploy-field">
                <span>Port 8102 · large</span>
                <select value={keyB} onChange={(e) => pickB(e.target.value)} disabled={busy}>
                  {options.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <a className="deploy-hf-link" href={hfModelUrl(hfB)} target="_blank" rel="noreferrer">
                  {hfB}
                </a>
              </label>
            </div>

            <div className="deploy-add-hf-row">
              <input
                type="url"
                className="deploy-hf-input"
                value={addInput}
                disabled={busy}
                placeholder="Add from a Hugging Face link or org/model"
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
                Add
              </button>
            </div>
            {addError ? <p className="deploy-error">{addError}</p> : null}
          </div>

          <div className="deploy-section">
            <h2>Steps</h2>
            <ol className="deploy-steps">
              {steps.map((step) => {
                const blocked = !statusReady || !sshReady || Boolean(step.blockedBy);
                const stepRunning = step.actions.some((a) => a.op === runningOp);
                return (
                  <li
                    key={step.n}
                    className={`deploy-step${step.done ? ' is-done' : ''}${
                      stepRunning ? ' is-running' : ''
                    }`}
                  >
                    <span className="deploy-step-num" aria-hidden>
                      {stepRunning ? '·' : step.done ? '✓' : step.n}
                    </span>
                    <div className="deploy-step-body">
                      <p className="deploy-step-title">{step.title}</p>
                      <p className="deploy-step-desc">
                        {!statusReady
                          ? 'Checking current state…'
                          : stepRunning
                            ? 'Running on the GPU host — watch the shell.'
                            : (step.blockedBy ?? step.desc)}
                      </p>
                      <div className="deploy-step-actions">
                        {step.actions.map((a) => (
                          <button
                            key={a.label}
                            type="button"
                            className={a.primary ? 'deploy-op-btn is-primary' : 'deploy-op-btn'}
                            onClick={() => runAction(a)}
                            disabled={
                              blocked ||
                              busy ||
                              busyTunnel ||
                              (runningOp !== null && a.op !== 'tunnel')
                            }
                          >
                            {a.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>

          <div className="deploy-section">
            <h2>Shell</h2>
            <div className="deploy-ops">
              <button
                type="button"
                className="app-ghost-btn"
                onClick={() => void injectHelper('interrupt')}
                disabled={!sshReady}
              >
                Ctrl+C
              </button>
              <button
                type="button"
                className="app-ghost-btn"
                onClick={() => void injectHelper('tail-s')}
                disabled={!sshReady}
              >
                Log 8101
              </button>
              <button
                type="button"
                className="app-ghost-btn"
                onClick={() => void injectHelper('tail-l')}
                disabled={!sshReady}
              >
                Log 8102
              </button>
              <button
                type="button"
                className="app-ghost-btn"
                onClick={() => void injectHelper('gpu')}
                disabled={!sshReady}
              >
                nvidia-smi
              </button>
            </div>
          </div>

          {notice ? <p className="deploy-notice">{notice}</p> : null}

          {remote ? (
            <dl className="deploy-facts">
              <div>
                <dt>Services</dt>
                <dd>
                  8101 {remote.S_ACTIVE || 'unknown'} · 8102 {remote.L_ACTIVE || 'unknown'}
                </dd>
              </div>
              <div>
                <dt>GPU</dt>
                <dd>
                  {remote.GPU_NAME ?? 'unknown'}
                  {remote.GPU_FREE_MIB ? ` · ${remote.GPU_FREE_MIB} MiB free` : ''}
                </dd>
              </div>
              <div>
                <dt>Measured</dt>
                <dd>
                  {measured
                    ? `util ${remote.GPU_MEM_UTIL_S ?? '?'} / ${remote.GPU_MEM_UTIL_L ?? '?'} · ${
                        remote.QUANTIZATION_L === 'fp8' ? 'fp8' : 'bf16'
                      }`
                    : 'not measured'}
                </dd>
              </div>
              <div>
                <dt>Throughput</dt>
                <dd>
                  {benchmarked
                    ? `${remote.MEASURED_TOK_PER_SEC_S ?? '?'} / ${remote.MEASURED_TOK_PER_SEC_L} tok/s`
                    : 'run Benchmark'}
                </dd>
              </div>
              {tunnelOn ? (
                <div>
                  <dt>Tunnel</dt>
                  <dd>
                    localhost:{status?.tunnel.localSPort} / {status?.tunnel.localLPort}
                  </dd>
                </div>
              ) : null}
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
