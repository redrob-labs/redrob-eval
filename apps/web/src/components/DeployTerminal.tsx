'use client';

import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import '@xterm/xterm/css/xterm.css';

export type DeployTerminalHandle = {
  sessionId: string | null;
  status: 'idle' | 'connecting' | 'open' | 'error';
  open: () => Promise<void>;
  focus: () => void;
};

/**
 * Browser web terminal attached to the persistent tmux session on the GPU host.
 *
 * The session outlives this component: unmounting only drops the stream, so a
 * reload reattaches to work already in flight instead of restarting it. Deploy
 * ops are injected into that session — live output + Ctrl+C.
 */
export const DeployTerminal = forwardRef<
  DeployTerminalHandle,
  { sshReady: boolean; autoOpen?: boolean; onOpened?: () => void }
>(function DeployTerminal({ sshReady, autoOpen = false, onOpened }, ref) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<{ focus: () => void } | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'open' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [reused, setReused] = useState(false);
  const cleanupRef = useRef<() => void>(() => {});
  const openingRef = useRef(false);
  /** Last sequence number written to the screen, so a reconnect skips the gap. */
  const lastSeqRef = useRef<number>(0);

  const open = useCallback(async () => {
    if (openingRef.current || status === 'connecting' || status === 'open') return;
    openingRef.current = true;
    setStatus('connecting');
    setError(null);
    try {
      const { Terminal } = await import('@xterm/xterm');
      const { FitAddon } = await import('@xterm/addon-fit');

      const res = await fetch('/api/deploy/terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const state = (await res.json()) as { id: string; reused?: boolean };
      const id = state.id;
      setSessionId(id);
      setReused(Boolean(state.reused));

      const term = new Terminal({
        convertEol: true,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 13,
        theme: { background: '#0b0f14', cursor: '#6f8bff' },
        cursorBlink: true,
        scrollback: 20000,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      if (containerRef.current) {
        term.open(containerRef.current);
        try {
          fit.fit();
        } catch {
          /* ignore */
        }
      }
      termRef.current = term;

      const postInput = (data: string) => {
        void fetch(`/api/deploy/terminal/${id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data }),
        });
      };
      const disposable = term.onData(postInput);

      // Fresh attach replays the buffer; the browser tracks the cursor so an
      // auto-reconnect (Last-Event-ID) only fills the gap.
      lastSeqRef.current = 0;
      const es = new EventSource(`/api/deploy/terminal/${id}/output`);
      es.onmessage = (ev) => {
        if (ev.lastEventId) {
          const seq = Number(ev.lastEventId);
          if (Number.isFinite(seq)) lastSeqRef.current = seq;
        }
        try {
          term.write(JSON.parse(ev.data) as string);
        } catch {
          /* ignore */
        }
      };

      let lastCols = 0;
      let lastRows = 0;
      const onResize = () => {
        try {
          fit.fit();
          if (term.cols === lastCols && term.rows === lastRows) return;
          lastCols = term.cols;
          lastRows = term.rows;
          void fetch(`/api/deploy/terminal/${id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cols: term.cols, rows: term.rows }),
          });
        } catch {
          /* ignore */
        }
      };
      window.addEventListener('resize', onResize);

      // The toolbar above grows and shrinks (banners, notices), so the terminal
      // box changes size without a window resize — refit on the box itself.
      let raf = 0;
      const observer = new ResizeObserver(() => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(onResize);
      });
      if (containerRef.current) observer.observe(containerRef.current);

      onResize();
      term.focus();
      setStatus('open');
      onOpened?.();

      // Drops the stream only — the tmux session keeps running on the host.
      cleanupRef.current = () => {
        window.removeEventListener('resize', onResize);
        cancelAnimationFrame(raf);
        observer.disconnect();
        disposable.dispose();
        es.close();
        term.dispose();
        termRef.current = null;
      };
    } catch (e) {
      setStatus('error');
      setError(e instanceof Error ? e.message : 'Failed to open terminal');
    } finally {
      openingRef.current = false;
    }
  }, [status, onOpened]);

  /** Stop watching, leave the op running on the host. */
  const detach = () => {
    cleanupRef.current();
    cleanupRef.current = () => {};
    if (sessionId) {
      void fetch(`/api/deploy/terminal/${sessionId}`, { method: 'DELETE' });
    }
    setSessionId(null);
    setStatus('idle');
    setReused(false);
  };

  /** Kill the tmux session — ends whatever op is running. */
  const endSession = () => {
    cleanupRef.current();
    cleanupRef.current = () => {};
    if (sessionId) {
      void fetch(`/api/deploy/terminal/${sessionId}?kill=1`, { method: 'DELETE' });
    }
    setSessionId(null);
    setStatus('idle');
    setReused(false);
  };

  useImperativeHandle(
    ref,
    () => ({
      sessionId,
      status,
      open,
      focus: () => termRef.current?.focus(),
    }),
    [sessionId, status, open],
  );

  useEffect(() => {
    if (autoOpen && sshReady && status === 'idle') {
      void open();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen, sshReady]);

  // Unmount tears down the view, never the remote session.
  useEffect(() => {
    return () => cleanupRef.current();
  }, []);

  return (
    <div className="deploy-terminal deploy-terminal-main">
      <div className="deploy-terminal-bar">
        <span className="deploy-terminal-title">Remote shell</span>
        <span className="deploy-terminal-hint">
          {status === 'open' && reused
            ? 'Reattached — steps already running kept going'
            : 'Runs in tmux — steps survive a disconnect'}
        </span>
        {status === 'open' ? (
          <>
            <button
              type="button"
              className="app-ghost-btn"
              onClick={detach}
              title="Stop watching. Steps keep running on the GPU host."
            >
              Detach
            </button>
            <button
              type="button"
              className="app-ghost-btn"
              onClick={endSession}
              title="Kill the tmux session and stop whatever step is running."
            >
              End session
            </button>
          </>
        ) : (
          <button
            type="button"
            className="app-ghost-btn"
            onClick={() => void open()}
            disabled={!sshReady || status === 'connecting'}
            title={sshReady ? 'Attach to the remote shell' : 'Set GPU_HOST / GPU_USER / GPU_SSH_KEY first'}
          >
            {status === 'connecting' ? 'Attaching…' : 'Attach shell'}
          </button>
        )}
      </div>
      {error ? <p className="deploy-error">{error}</p> : null}
      <div
        ref={containerRef}
        className="deploy-terminal-surface"
        data-empty={sessionId ? undefined : 'true'}
      />
    </div>
  );
});
