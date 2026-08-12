import { randomBytes } from 'node:crypto';
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_VLLM_PORT } from '../deploy/port';

/**
 * Browser-editable environment for this local workbench.
 *
 * Values are persisted to the repo-root `.env` (gitignored) and applied to
 * `process.env` immediately so no restart is needed. Secret values are never
 * sent back to the browser — only a masked hint and a set/unset flag.
 *
 * Plain/path fields may declare a `defaultValue`. When the env key is absent,
 * that default is used at runtime and shown in Settings.
 */

export type SettingKind = 'secret' | 'plain' | 'path';

export interface SettingDef {
  key: string;
  label: string;
  group: 'providers' | 'selfhosted' | 'gpu';
  kind: SettingKind;
  hint?: string;
  placeholder?: string;
  /** Used when the env key is unset. Never for secrets. */
  defaultValue?: string;
  /** A default that only exists at runtime, such as one built from another setting. */
  deriveDefault?: () => string | undefined;
}

export const SETTING_DEFS: SettingDef[] = [
  // Provider API keys
  {
    key: 'OPENROUTER_API_KEY',
    label: 'OpenRouter',
    group: 'providers',
    kind: 'secret',
    hint: 'Widest model coverage, the usual starting key.',
  },
  { key: 'OPENAI_API_KEY', label: 'OpenAI', group: 'providers', kind: 'secret' },
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic', group: 'providers', kind: 'secret' },
  { key: 'GOOGLE_API_KEY', label: 'Google', group: 'providers', kind: 'secret' },
  { key: 'TOGETHER_API_KEY', label: 'Together', group: 'providers', kind: 'secret' },
  { key: 'FIREWORKS_API_KEY', label: 'Fireworks', group: 'providers', kind: 'secret' },

  // Self-hosted vLLM endpoints
  {
    key: 'VLLM_API_KEY',
    label: 'vLLM API key',
    group: 'selfhosted',
    kind: 'secret',
    hint: 'Local bearer for vLLM --api-key (not Hugging Face). Auto-issued when you open Deploy shell or run Install.',
  },
  {
    key: 'VLLM_PORT',
    label: 'vLLM port',
    group: 'selfhosted',
    kind: 'plain',
    defaultValue: String(DEFAULT_VLLM_PORT),
    hint: 'Port exposed by Deploy. vLLM convention is 8000; choose another port when the host already uses it.',
  },
  {
    key: 'VLLM_BASE_URL',
    label: 'Base URL',
    group: 'selfhosted',
    kind: 'plain',
    // Static localhost, never derived from GPU_HOST: a placeholder should show a
    // generic example, not leak the deployed hostname. Set this (or add a vLLM
    // host below) to reach a remote deploy.
    defaultValue: `http://localhost:${DEFAULT_VLLM_PORT}/v1`,
    hint: 'Where the deployed model answers. Defaults to localhost; set it to the GPU host to reach a remote deploy.',
  },
  {
    key: 'HF_TOKEN',
    label: 'Hugging Face token',
    group: 'selfhosted',
    kind: 'secret',
    hint: 'GPU host uses this to download models. Create at huggingface.co/settings/tokens (Read access is enough).',
  },

  // GPU host (SSH)
  {
    key: 'GPU_HOST',
    label: 'GPU host',
    group: 'gpu',
    kind: 'plain',
    placeholder: 'hostname or IP',
  },
  {
    key: 'GPU_USER',
    label: 'SSH user',
    group: 'gpu',
    kind: 'plain',
    defaultValue: 'ubuntu',
  },
  {
    key: 'GPU_SSH_KEY',
    label: 'SSH private key',
    group: 'gpu',
    kind: 'path',
    hint: 'Path on this machine. The file is read server-side only, never uploaded.',
  },
  {
    key: 'GPU_SSH_PORT',
    label: 'SSH port',
    group: 'gpu',
    kind: 'plain',
    defaultValue: '22',
  },
];

const DEF_BY_KEY = new Map(SETTING_DEFS.map((d) => [d.key, d]));

export function isEditableKey(key: string): boolean {
  return DEF_BY_KEY.has(key);
}

/** Repo-root .env — next.config.ts loads this at boot; we keep it in sync. */
export function envFilePath(): string {
  // apps/web is the server cwd in dev; repo root is two levels up.
  const cwd = process.cwd();
  const base = cwd.endsWith(path.join('apps', 'web')) ? path.join(cwd, '..', '..') : cwd;
  return path.join(base, '.env');
}

export interface SettingView {
  key: string;
  label: string;
  group: SettingDef['group'];
  kind: SettingKind;
  hint?: string;
  placeholder?: string;
  defaultValue: string | null;
  /** Secrets: masked hint only. Plain/path: the stored env value, or null if unset. */
  value: string | null;
  /** What the app uses right now: stored value, else default. */
  effective: string | null;
  /** True when the key is explicitly set in the environment / .env */
  set: boolean;
}

function mask(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return '••••';
  return `••••${trimmed.slice(-4)}`;
}

/** Snapshot of env values as loaded from .env/shell — before defaults. */
const baselineEnv = new Map<string, string>();
let baselineReady = false;

/**
 * Capture which keys were explicitly present, then inject defaults into
 * process.env for absent keys (so deploy/eval see them) without marking
 * those keys as "set" in the Settings UI.
 */
function defaultFor(def: SettingDef): string | null {
  return def.defaultValue ?? def.deriveDefault?.() ?? null;
}

/** A derived default can change when the setting it reads changes, so this reruns. */
function applyDefaults(): void {
  for (const d of SETTING_DEFS) {
    const fallback = defaultFor(d);
    if (!fallback) continue;
    if (!(baselineEnv.get(d.key) ?? '')) process.env[d.key] = fallback;
  }
}

function ensureBaseline(): void {
  if (baselineReady) return;
  for (const d of SETTING_DEFS) {
    baselineEnv.set(d.key, process.env[d.key]?.trim() ?? '');
  }
  applyDefaults();
  baselineReady = true;
}

/** Call from routes / deploy so defaults are live even before Settings opens. */
export function ensureSettingsDefaultsApplied(): void {
  ensureBaseline();
}

/**
 * Mint a local VLLM_API_KEY if unset, persist to .env, and return it.
 * Not a cloud credential: a shared secret for vLLM --api-key on the GPU host
 * and for Eval calling it. The port is open, so this is the only thing standing
 * in front of the endpoint. Idempotent once stored.
 */
export async function ensureVllmApiKey(): Promise<string> {
  ensureBaseline();
  const fromBaseline = (baselineEnv.get('VLLM_API_KEY') ?? '').trim();
  if (fromBaseline) {
    process.env.VLLM_API_KEY = fromBaseline;
    return fromBaseline;
  }
  const fromEnv = (process.env.VLLM_API_KEY ?? '').trim();
  if (fromEnv) {
    // Already in the process (e.g. shell export) — use it without rewriting .env
    // mid-request (that can restart the dev server and surface as Failed to fetch).
    baselineEnv.set('VLLM_API_KEY', fromEnv);
    return fromEnv;
  }
  const key = `redrob_${randomBytes(24).toString('base64url')}`;
  await updateSettings({ VLLM_API_KEY: key });
  return key;
}

export function readSettings(): SettingView[] {
  ensureBaseline();
  return SETTING_DEFS.map((d) => {
    const raw = (baselineEnv.get(d.key) ?? '').trim();
    const set = raw.length > 0;
    const defaultValue = defaultFor(d);
    const effective = set ? raw : defaultValue;
    return {
      key: d.key,
      label: d.label,
      group: d.group,
      kind: d.kind,
      hint: d.hint,
      placeholder: d.placeholder ?? defaultValue ?? undefined,
      defaultValue,
      value: !set ? null : d.kind === 'secret' ? mask(raw) : raw,
      effective:
        effective == null
          ? null
          : d.kind === 'secret' && set
            ? mask(effective)
            : d.kind === 'secret'
              ? null
              : effective,
      set,
    };
  });
}

function serializeValue(value: string): string {
  // Quote when the value has spaces or characters that would break `KEY=value`
  return /[\s"'#]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/**
 * Merge updates into the repo-root .env, preserving unrelated lines,
 * comments, and ordering. Empty string removes the key.
 */
async function writeEnvFile(updates: Record<string, string>): Promise<string> {
  const file = envFilePath();
  let existing = '';
  try {
    await access(file);
    existing = await readFile(file, 'utf8');
  } catch {
    await mkdir(path.dirname(file), { recursive: true });
  }

  const lines = existing.length > 0 ? existing.split(/\r?\n/) : [];
  const remaining = new Map(Object.entries(updates));
  const out: string[] = [];

  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!m) {
      out.push(line);
      continue;
    }
    const key = m[1]!;
    if (!remaining.has(key)) {
      out.push(line);
      continue;
    }
    const value = remaining.get(key)!;
    remaining.delete(key);
    if (value.length === 0) continue; // removal
    out.push(`${key}=${serializeValue(value)}`);
  }

  const additions = [...remaining.entries()].filter(([, v]) => v.length > 0);
  if (additions.length > 0) {
    if (out.length > 0 && out[out.length - 1]!.trim() !== '') out.push('');
    out.push('# Set from the redrob-eval Settings page');
    for (const [key, value] of additions) out.push(`${key}=${serializeValue(value)}`);
  }

  const content = out.join('\n').replace(/\n{3,}$/, '\n') + '\n';
  await writeFile(file, content, { encoding: 'utf8', mode: 0o600 });
  try {
    await chmod(file, 0o600);
  } catch {
    // Windows / restricted FS — best effort
  }
  return file;
}

/** Apply updates to process.env and persist them. Returns the .env path used. */
export async function updateSettings(
  updates: Record<string, string>,
): Promise<{ file: string; applied: string[] }> {
  ensureBaseline();
  const filtered: Record<string, string> = {};
  for (const [key, raw] of Object.entries(updates)) {
    if (!isEditableKey(key)) continue;
    filtered[key] = typeof raw === 'string' ? raw.trim() : '';
  }

  for (const [key, value] of Object.entries(filtered)) {
    baselineEnv.set(key, value);
    if (value.length === 0) delete process.env[key];
    else process.env[key] = value;
  }
  // Saving the GPU host is what gives the vLLM base URL a default, so the
  // defaults are recomputed here rather than only at startup.
  applyDefaults();

  const file = await writeEnvFile(filtered);
  return { file, applied: Object.keys(filtered) };
}
