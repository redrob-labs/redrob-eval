import { createServer, type Server } from 'node:net';
import { readFile } from 'node:fs/promises';
import { Client } from 'ssh2';
import { readGpuSshEnv } from './ssh';

/**
 * In-process SSH local forwards so the web server can reach vLLM endpoints
 * that are bound to 127.0.0.1 on the GPU host (never 0.0.0.0).
 *
 * The UI toggles this from the Tunnel step; when active, the eval
 * provider talks to local forwarded ports. No separate shell needed.
 */

export interface TunnelState {
  active: boolean;
  localSPort: number | null;
  localLPort: number | null;
}

interface ActiveTunnel {
  client: Client;
  servers: Server[];
  localSPort: number;
  localLPort: number;
}

// Module-scoped singleton (persists across requests in the dev/prod server process).
const g = globalThis as unknown as { __redrobTunnel?: ActiveTunnel | null };

const REMOTE_S_PORT = 8101;
const REMOTE_L_PORT = 8102;
const LOCAL_S_PORT = Number(process.env.LOCAL_S_PORT?.trim() || 8101);
const LOCAL_L_PORT = Number(process.env.LOCAL_L_PORT?.trim() || 8102);

function forward(client: Client, localPort: number, remotePort: number): Promise<Server> {
  const server = createServer((socket) => {
    client.forwardOut('127.0.0.1', localPort, '127.0.0.1', remotePort, (err, stream) => {
      if (err) {
        socket.destroy();
        return;
      }
      socket.pipe(stream).pipe(socket);
      stream.on('error', () => socket.destroy());
      socket.on('error', () => stream.end());
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(localPort, '127.0.0.1', () => resolve(server));
  });
}

export function tunnelState(): TunnelState {
  const t = g.__redrobTunnel;
  return {
    active: Boolean(t),
    localSPort: t?.localSPort ?? null,
    localLPort: t?.localLPort ?? null,
  };
}

export async function startTunnel(): Promise<TunnelState> {
  if (g.__redrobTunnel) return tunnelState();
  const env = readGpuSshEnv();
  const privateKey = await readFile(env.keyPath);
  const client = new Client();

  await new Promise<void>((resolve, reject) => {
    client
      .on('ready', () => resolve())
      .on('error', reject)
      .connect({
        host: env.host,
        port: env.port,
        username: env.user,
        privateKey,
        readyTimeout: 20_000,
        keepaliveInterval: 15_000,
      });
  });

  const sServer = await forward(client, LOCAL_S_PORT, REMOTE_S_PORT);
  const lServer = await forward(client, LOCAL_L_PORT, REMOTE_L_PORT);

  g.__redrobTunnel = {
    client,
    servers: [sServer, lServer],
    localSPort: LOCAL_S_PORT,
    localLPort: LOCAL_L_PORT,
  };

  // Point the eval provider at the forwarded loopback ports for this process.
  process.env.VLLM_S_BASE_URL = `http://127.0.0.1:${LOCAL_S_PORT}/v1`;
  process.env.VLLM_L_BASE_URL = `http://127.0.0.1:${LOCAL_L_PORT}/v1`;

  return tunnelState();
}

export function stopTunnel(): TunnelState {
  const t = g.__redrobTunnel;
  if (t) {
    for (const s of t.servers) {
      try {
        s.close();
      } catch {
        /* ignore */
      }
    }
    try {
      t.client.end();
    } catch {
      /* ignore */
    }
    g.__redrobTunnel = null;
  }
  return tunnelState();
}
