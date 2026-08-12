import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { VLLM_ENV } from '@redrob/harness';

import { envFilePath } from './env-store';

/**
 * Registry of vLLM endpoints this workbench can call.
 *
 * The endpoint Deploy serves stays where it was, in `VLLM_BASE_URL`, which
 * defaults to the GPU host. It appears here as a read-only built-in. Anything
 * else the user adds lives in a gitignored JSON file beside `.env`.
 *
 * Keys never leave the server. Callers pass a host id and the server resolves
 * it, so a browser can never point a server-side fetch at an address of its
 * choosing.
 */

export interface VllmHostRecord {
  id: string;
  label: string;
  baseUrl: string;
  /** Optional per-host bearer. Falls back to VLLM_API_KEY when absent. */
  apiKey?: string;
  createdAt: string;
  /** Set when Deploy auto-registers a slot endpoint; cleared on undeploy. */
  deploySlot?: number;
}

export type VllmHostSource = 'builtin' | 'custom';

/** Browser-safe projection: no key material, only whether one is stored. */
export interface VllmHostView {
  id: string;
  label: string;
  baseUrl: string;
  source: VllmHostSource;
  /** Built-ins are edited through the Settings env fields instead. */
  editable: boolean;
  /** Which env var backs this built-in, for the Settings hint. */
  envKey: string | null;
  hasOwnKey: boolean;
  keyHint: string | null;
}

export interface ResolvedVllmHost {
  id: string;
  label: string;
  baseUrl: string;
  /** Per-host key when set, otherwise the shared VLLM_API_KEY. */
  apiKey: string | null;
}

export const BUILTIN_HOST_ID = 'builtin';

const MAX_LABEL = 60;

function storeFilePath(): string {
  return path.join(path.dirname(envFilePath()), '.redrob', 'vllm-hosts.json');
}

/**
 * A bare origin is almost always a vLLM server on its default OpenAI path, and
 * silently probing the wrong path is a worse failure than assuming this.
 */
export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Base URL is required');

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Not a valid URL: ${trimmed}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Base URL must be http or https, got ${url.protocol}`);
  }
  url.hash = '';
  url.search = '';

  const cleanPath = url.pathname.replace(/\/+$/, '');
  url.pathname = cleanPath === '' ? '/v1' : cleanPath;
  return url.toString().replace(/\/+$/, '');
}

function normalizeLabel(input: string): string {
  const label = input.trim().replace(/\s+/g, ' ');
  if (!label) throw new Error('Name is required');
  if (label.length > MAX_LABEL) {
    throw new Error(`Name must be ${MAX_LABEL} characters or fewer`);
  }
  return label;
}

function maskKey(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 4 ? '••••' : `••••${trimmed.slice(-4)}`;
}

async function readStore(): Promise<VllmHostRecord[]> {
  try {
    const raw = await readFile(storeFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as { hosts?: unknown };
    if (!Array.isArray(parsed.hosts)) return [];
    return parsed.hosts.filter((h): h is VllmHostRecord => {
      if (!h || typeof h !== 'object') return false;
      const rec = h as Partial<VllmHostRecord>;
      return (
        typeof rec.id === 'string' &&
        typeof rec.label === 'string' &&
        typeof rec.baseUrl === 'string'
      );
    });
  } catch {
    // Absent or unreadable: an empty registry is the correct answer either way.
    return [];
  }
}

async function writeStore(hosts: VllmHostRecord[]): Promise<void> {
  const file = storeFilePath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ hosts }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    await chmod(file, 0o600);
  } catch {
    // Windows / restricted FS: best effort, same as the .env writer.
  }
}

function builtinHost(): VllmHostView {
  return {
    id: BUILTIN_HOST_ID,
    label: 'Deployed endpoint',
    baseUrl: process.env[VLLM_ENV.baseUrl]?.trim() || VLLM_ENV.defaultBaseUrl,
    source: 'builtin',
    editable: false,
    envKey: VLLM_ENV.baseUrl,
    hasOwnKey: false,
    keyHint: null,
  };
}

function toView(record: VllmHostRecord): VllmHostView {
  return {
    id: record.id,
    label: record.label,
    baseUrl: record.baseUrl,
    source: 'custom',
    editable: true,
    envKey: null,
    hasOwnKey: Boolean(record.apiKey),
    keyHint: record.apiKey ? maskKey(record.apiKey) : null,
  };
}

export async function listVllmHosts(): Promise<VllmHostView[]> {
  const custom = await readStore();
  return [builtinHost(), ...custom.map(toView)];
}

export async function resolveVllmHost(id: string): Promise<ResolvedVllmHost | null> {
  const shared = process.env[VLLM_ENV.apiKey]?.trim() || null;

  if (id === BUILTIN_HOST_ID) {
    const builtin = builtinHost();
    return {
      id: builtin.id,
      label: builtin.label,
      baseUrl: builtin.baseUrl,
      apiKey: shared,
    };
  }

  const record = (await readStore()).find((h) => h.id === id);
  if (!record) return null;
  return {
    id: record.id,
    label: record.label,
    baseUrl: record.baseUrl,
    apiKey: record.apiKey?.trim() || shared,
  };
}

export async function addVllmHost(input: {
  label: string;
  baseUrl: string;
  apiKey?: string;
}): Promise<VllmHostView> {
  const hosts = await readStore();
  const record: VllmHostRecord = {
    id: randomUUID(),
    label: normalizeLabel(input.label),
    baseUrl: normalizeBaseUrl(input.baseUrl),
    createdAt: new Date().toISOString(),
  };
  const apiKey = input.apiKey?.trim();
  if (apiKey) record.apiKey = apiKey;

  if (hosts.some((h) => h.baseUrl === record.baseUrl)) {
    throw new Error(`A host with base URL ${record.baseUrl} already exists`);
  }

  hosts.push(record);
  await writeStore(hosts);
  return toView(record);
}

/** Undefined fields are left alone; an empty apiKey string clears the stored key. */
export async function updateVllmHost(
  id: string,
  patch: { label?: string; baseUrl?: string; apiKey?: string },
): Promise<VllmHostView> {
  const hosts = await readStore();
  const record = hosts.find((h) => h.id === id);
  if (!record) throw new Error(`Unknown host: ${id}`);

  if (patch.label !== undefined) record.label = normalizeLabel(patch.label);
  if (patch.baseUrl !== undefined) {
    const baseUrl = normalizeBaseUrl(patch.baseUrl);
    if (hosts.some((h) => h.id !== id && h.baseUrl === baseUrl)) {
      throw new Error(`A host with base URL ${baseUrl} already exists`);
    }
    record.baseUrl = baseUrl;
  }
  if (patch.apiKey !== undefined) {
    const apiKey = patch.apiKey.trim();
    if (apiKey) record.apiKey = apiKey;
    else delete record.apiKey;
  }

  await writeStore(hosts);
  return toView(record);
}

export async function removeVllmHost(id: string): Promise<void> {
  const hosts = await readStore();
  const next = hosts.filter((h) => h.id !== id);
  if (next.length === hosts.length) throw new Error(`Unknown host: ${id}`);
  await writeStore(next);
}

/**
 * Register or refresh the endpoint Deploy just started for a slot.
 * Identified by deploySlot (and by baseUrl when an older auto-entry lacks it).
 */
export async function upsertDeploySlotHost(input: {
  slot: number;
  label: string;
  baseUrl: string;
}): Promise<VllmHostView> {
  const hosts = await readStore();
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const label = normalizeLabel(input.label);
  const existing =
    hosts.find((h) => h.deploySlot === input.slot) ??
    hosts.find((h) => h.baseUrl === baseUrl);

  if (existing) {
    existing.label = label;
    existing.baseUrl = baseUrl;
    existing.deploySlot = input.slot;
    await writeStore(hosts);
    return toView(existing);
  }

  const record: VllmHostRecord = {
    id: randomUUID(),
    label,
    baseUrl,
    createdAt: new Date().toISOString(),
    deploySlot: input.slot,
  };
  hosts.push(record);
  await writeStore(hosts);
  return toView(record);
}

/** Drop auto-registered hosts for a slot (by deploySlot, or Slot-labelled URL port). */
export async function removeDeploySlotHost(slot: number, port: number): Promise<void> {
  const hosts = await readStore();
  const next = hosts.filter((h) => {
    if (h.deploySlot === slot) return false;
    if (h.deploySlot !== undefined) return true;
    try {
      const url = new URL(h.baseUrl);
      const hostPort = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
      if (hostPort === port && /^Slot \d+:/.test(h.label)) return false;
    } catch {
      /* keep */
    }
    return true;
  });
  if (next.length !== hosts.length) await writeStore(next);
}
