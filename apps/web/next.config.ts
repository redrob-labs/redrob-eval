import type { NextConfig } from 'next';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Load repo-root `.env` into process.env (Next only auto-loads apps/web/.env). */
function loadRootEnv(): void {
  const rootEnv = path.join(__dirname, '../../.env');
  if (!existsSync(rootEnv)) return;
  for (const raw of readFileSync(rootEnv, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    // Don't override vars already set in the shell / apps/web/.env
    if (process.env[key] == null || process.env[key] === '') {
      process.env[key] = val;
    }
  }
}

loadRootEnv();

const nextConfig: NextConfig = {
  transpilePackages: ['@redrob/harness', '@redrob/tokenizers'],
  // Monorepo: eval artifacts and datasets live at repo root
  outputFileTracingRoot: path.join(__dirname, '../..'),
  // ssh2 has optional native deps — keep it external to the server bundle
  serverExternalPackages: ['ssh2'],
};

export default nextConfig;
