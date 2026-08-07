import { readFile } from 'node:fs/promises';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import { ensureSettingsDefaultsApplied } from '@/lib/settings/env-store';

/**
 * Server-only SSH access to the GPU host.
 * All connection details come from environment variables — never hardcoded,
 * never returned to the browser:
 *   GPU_HOST, GPU_USER, GPU_SSH_KEY (path to private key), optional GPU_SSH_PORT.
 * Secrets (key material, VLLM_API_KEY, HF_TOKEN) are never logged or echoed.
 */

export interface GpuSshEnv {
  host: string;
  user: string;
  keyPath: string;
  port: number;
}

export class SshConfigError extends Error {
  constructor(
    message: string,
    readonly missing: string[],
  ) {
    super(message);
    this.name = 'SshConfigError';
  }
}

/** Which required deploy env vars are present — booleans only, never values. */
export function deployEnvPresence(): Record<string, boolean> {
  ensureSettingsDefaultsApplied();
  return {
    GPU_HOST: Boolean(process.env.GPU_HOST?.trim()),
    GPU_USER: Boolean(process.env.GPU_USER?.trim()),
    GPU_SSH_KEY: Boolean(process.env.GPU_SSH_KEY?.trim()),
    VLLM_API_KEY: Boolean(process.env.VLLM_API_KEY?.trim()),
    HF_TOKEN: Boolean(process.env.HF_TOKEN?.trim()),
  };
}

export function readGpuSshEnv(): GpuSshEnv {
  ensureSettingsDefaultsApplied();
  const host = process.env.GPU_HOST?.trim();
  const user = process.env.GPU_USER?.trim();
  const keyPath = process.env.GPU_SSH_KEY?.trim();
  const port = Number(process.env.GPU_SSH_PORT?.trim() || 22);

  const missing: string[] = [];
  if (!host) missing.push('GPU_HOST');
  if (!user) missing.push('GPU_USER');
  if (!keyPath) missing.push('GPU_SSH_KEY');
  if (missing.length > 0) {
    throw new SshConfigError(
      `Missing deploy env: ${missing.join(', ')}. Inject via environment only.`,
      missing,
    );
  }
  return { host: host!, user: user!, keyPath: keyPath!, port: Number.isFinite(port) ? port : 22 };
}

async function connectConfig(env: GpuSshEnv): Promise<ConnectConfig> {
  const privateKey = await readFile(env.keyPath);
  return {
    host: env.host,
    port: env.port,
    username: env.user,
    privateKey,
    // Fail fast rather than hanging the UI when host is unreachable
    readyTimeout: 20_000,
    keepaliveInterval: 15_000,
  };
}

function newClient(): Client {
  return new Client();
}

export interface ExecOptions {
  /** Wrap the command with sudo -n bash -lc when true (root ops) */
  sudo?: boolean;
  /** Called for every stdout/stderr chunk (already utf-8 decoded) */
  onData?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  signal?: AbortSignal;
  /** Extra environment for the remote command (non-secret) */
  env?: Record<string, string>;
}

export interface ExecResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

/**
 * Run one command on the GPU host over SSH, streaming output via onData.
 * The command string is executed with `bash -lc`. Secrets passed through
 * `secretEnv` are exported inside the remote shell and never appear in logs.
 */
export async function sshExec(
  command: string,
  opts: ExecOptions & { secretEnv?: Record<string, string> } = {},
): Promise<ExecResult> {
  const env = readGpuSshEnv();
  const cfg = await connectConfig(env);
  const client = newClient();

  const secretExports = Object.entries(opts.secretEnv ?? {})
    .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
    .join('\n');
  const plainExports = Object.entries(opts.env ?? {})
    .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
    .join('\n');

  const inner = [secretExports, plainExports, command].filter(Boolean).join('\n');
  const wrapped = opts.sudo
    ? `sudo -n bash -lc ${shellQuote(inner)}`
    : `bash -lc ${shellQuote(inner)}`;

  return new Promise<ExecResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const cleanup = () => {
      opts.signal?.removeEventListener('abort', onAbort);
      try {
        client.end();
      } catch {
        /* ignore */
      }
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('aborted'));
    };
    if (opts.signal) {
      if (opts.signal.aborted) return onAbort();
      opts.signal.addEventListener('abort', onAbort);
    }

    client
      .on('ready', () => {
        client.exec(wrapped, { pty: false }, (err, stream: ClientChannel) => {
          if (err) {
            settled = true;
            cleanup();
            return reject(err);
          }
          stream
            .on('close', (code: number | null, signalName: string | null) => {
              if (settled) return;
              settled = true;
              cleanup();
              resolve({ code, signal: signalName, stdout, stderr });
            })
            .on('data', (data: Buffer) => {
              const s = data.toString('utf8');
              stdout += s;
              opts.onData?.(s, 'stdout');
            });
          stream.stderr.on('data', (data: Buffer) => {
            const s = data.toString('utf8');
            stderr += s;
            opts.onData?.(s, 'stderr');
          });
        });
      })
      .on('error', (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      })
      .connect(cfg);
  });
}

/** Copy small text content to a remote path via SFTP (0600). */
export async function sshWriteFile(remotePath: string, content: string): Promise<void> {
  const env = readGpuSshEnv();
  const cfg = await connectConfig(env);
  const client = newClient();
  return new Promise<void>((resolve, reject) => {
    client
      .on('ready', () => {
        client.sftp((err, sftp) => {
          if (err) {
            client.end();
            return reject(err);
          }
          const ws = sftp.createWriteStream(remotePath, { mode: 0o600 });
          ws.on('close', () => {
            client.end();
            resolve();
          });
          ws.on('error', (e: Error) => {
            client.end();
            reject(e);
          });
          ws.end(content);
        });
      })
      .on('error', reject)
      .connect(cfg);
  });
}

export interface ShellSession {
  id: string;
  write(data: string): void;
  onData(cb: (chunk: string) => void): void;
  resize(cols: number, rows: number): void;
  close(): void;
  readonly closed: boolean;
}

/** Name of the persistent tmux session that owns every deploy op. */
export const TMUX_SESSION = 'redrob';

/**
 * Attach to (or create) the persistent tmux session. Because the op runs
 * inside tmux rather than as a child of this SSH channel, it survives a
 * dropped connection and a later attach picks it back up mid-flight.
 * Without tmux the shell still works, it just cannot outlive the connection.
 */
const ATTACH_COMMAND = [
  'if command -v tmux >/dev/null 2>&1; then',
  `  exec tmux new-session -A -s ${TMUX_SESSION}`,
  'else',
  `  echo '[redrob] tmux not installed - ops will NOT survive a disconnect. Run Install to add it.'`,
  '  exec bash -l',
  'fi',
].join('\n');

/**
 * Open an interactive PTY on the GPU host attached to the persistent tmux
 * session. Used by the browser web terminal (output via SSE, input via POST).
 */
export async function openShellSession(
  id: string,
  size: { cols?: number; rows?: number } = {},
): Promise<ShellSession> {
  const env = readGpuSshEnv();
  const cfg = await connectConfig(env);
  const client = newClient();
  const cols = size.cols && size.cols > 0 ? size.cols : 100;
  const rows = size.rows && size.rows > 0 ? size.rows : 30;

  return new Promise<ShellSession>((resolve, reject) => {
    client
      .on('ready', () => {
        const pty = { term: 'xterm-256color', cols, rows };
        client.exec(ATTACH_COMMAND, { pty }, (err, stream: ClientChannel) => {
          if (err) {
            client.end();
            return reject(err);
          }
          const listeners: Array<(chunk: string) => void> = [];
          let closed = false;

          stream.on('data', (data: Buffer) => {
            const s = data.toString('utf8');
            for (const cb of listeners) cb(s);
          });
          stream.stderr.on('data', (data: Buffer) => {
            const s = data.toString('utf8');
            for (const cb of listeners) cb(s);
          });
          stream.on('close', () => {
            closed = true;
            try {
              client.end();
            } catch {
              /* ignore */
            }
          });

          resolve({
            id,
            write(data: string) {
              if (!closed) stream.write(data);
            },
            onData(cb) {
              listeners.push(cb);
            },
            resize(nextCols, nextRows) {
              if (!closed) stream.setWindow(nextRows, nextCols, 0, 0);
            },
            close() {
              if (closed) return;
              closed = true;
              try {
                stream.end();
                client.end();
              } catch {
                /* ignore */
              }
            },
            get closed() {
              return closed;
            },
          });
        });
      })
      .on('error', reject)
      .connect(cfg);
  });
}

/**
 * End the persistent tmux session, killing whatever op is running inside it.
 * Only used by an explicit "End session" - detaching leaves the op running.
 */
export async function killTmuxSession(): Promise<void> {
  await sshExec(`tmux kill-session -t ${TMUX_SESSION} 2>/dev/null || true`, { sudo: false });
}

/** POSIX single-quote a value for safe embedding in a remote bash command. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
