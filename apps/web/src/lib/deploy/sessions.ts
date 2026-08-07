import { killTmuxSession, openShellSession, type ShellSession } from './ssh';

/**
 * Terminal session registry for the browser web terminal.
 *
 * There is one GPU host, so there is one logical terminal (MAIN_TERMINAL_ID).
 * The SSH channel is disposable — the op itself lives in tmux on the host, so
 * reconnecting re-attaches to work already in flight.
 *
 * Output is buffered with monotonic sequence numbers so a reconnecting reader
 * can ask for "everything after N" instead of replaying the whole log.
 * Module-scoped singleton across requests.
 */

export const MAIN_TERMINAL_ID = 'main';

export interface Chunk {
  seq: number;
  data: string;
}

interface Entry {
  session: ShellSession;
  buffer: Chunk[];
  nextSeq: number;
  subscribers: Set<(chunk: Chunk) => void>;
  createdAt: number;
}

const g = globalThis as unknown as {
  __redrobTerminals?: Map<string, Entry>;
  __redrobTerminalOpening?: Map<string, Promise<Entry>>;
};

function registry(): Map<string, Entry> {
  if (!g.__redrobTerminals) g.__redrobTerminals = new Map();
  return g.__redrobTerminals;
}

/** In-flight opens, so concurrent callers share one SSH connect. */
function pending(): Map<string, Promise<Entry>> {
  if (!g.__redrobTerminalOpening) g.__redrobTerminalOpening = new Map();
  return g.__redrobTerminalOpening;
}

const MAX_BUFFER_CHUNKS = 4000;

function live(entry: Entry | undefined): entry is Entry {
  return Boolean(entry && !entry.session.closed);
}

async function openEntry(id: string, size: { cols?: number; rows?: number }): Promise<Entry> {
  const session = await openShellSession(id, size);
  const entry: Entry = {
    session,
    buffer: [],
    nextSeq: 1,
    subscribers: new Set(),
    createdAt: Date.now(),
  };
  session.onData((data) => {
    const chunk: Chunk = { seq: entry.nextSeq++, data };
    entry.buffer.push(chunk);
    if (entry.buffer.length > MAX_BUFFER_CHUNKS) entry.buffer.shift();
    for (const cb of entry.subscribers) cb(chunk);
  });
  registry().set(id, entry);
  return entry;
}

/**
 * Return the live terminal, reconnecting if the SSH channel died.
 * Idempotent: concurrent callers share one connect, and an already-open
 * session is reused rather than replaced (which would orphan the tmux pane).
 */
export async function ensureTerminal(
  size: { cols?: number; rows?: number } = {},
): Promise<{ id: string; reused: boolean }> {
  const id = MAIN_TERMINAL_ID;
  const existing = registry().get(id);
  if (live(existing)) return { id, reused: true };

  const inFlight = pending().get(id);
  if (inFlight) {
    await inFlight;
    return { id, reused: true };
  }

  // A closed entry keeps its buffer around for scrollback; drop it on reconnect
  // so sequence numbers restart cleanly against the fresh tmux repaint.
  registry().delete(id);

  const promise = openEntry(id, size);
  pending().set(id, promise);
  try {
    await promise;
  } finally {
    pending().delete(id);
  }
  return { id, reused: false };
}

export function writeTerminal(id: string, data: string): boolean {
  const entry = registry().get(id);
  if (!live(entry)) return false;
  entry.session.write(data);
  return true;
}

export function resizeTerminal(id: string, cols: number, rows: number): boolean {
  const entry = registry().get(id);
  if (!live(entry)) return false;
  entry.session.resize(cols, rows);
  return true;
}

/**
 * Subscribe to output. `since` is the last sequence number the reader already
 * has: pass null on a fresh attach to get the full buffer (scrollback catch-up),
 * or a seq to receive only the gap after a dropped connection.
 */
export function subscribeTerminal(
  id: string,
  since: number | null,
  cb: (chunk: Chunk) => void,
): { replay: Chunk[]; unsubscribe: () => void } | null {
  const entry = registry().get(id);
  if (!entry) return null;
  entry.subscribers.add(cb);
  const replay = since === null ? entry.buffer.slice() : entry.buffer.filter((c) => c.seq > since);
  return {
    replay,
    unsubscribe: () => entry.subscribers.delete(cb),
  };
}

/**
 * Drop the SSH channel but leave tmux running on the host, so the op keeps
 * going and the next attach picks it back up.
 */
export function detachTerminal(id: string): boolean {
  const entry = registry().get(id);
  if (!entry) return false;
  entry.session.close();
  registry().delete(id);
  return true;
}

/** Detach and kill the tmux session — ends whatever op is running. */
export async function killTerminal(id: string): Promise<boolean> {
  try {
    await killTmuxSession();
  } catch {
    /* host may be unreachable; still drop the local channel */
  }
  detachTerminal(id);
  return true;
}

export function terminalExists(id: string): boolean {
  return live(registry().get(id));
}

/** Highest sequence number buffered, so a reader can resume from the tail. */
export function terminalState(id: string): { id: string; alive: boolean; lastSeq: number } {
  const entry = registry().get(id);
  return {
    id,
    alive: live(entry),
    lastSeq: entry ? entry.nextSeq - 1 : 0,
  };
}
