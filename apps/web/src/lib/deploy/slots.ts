/**
 * Multi-slot deploy layout on a single GPU_HOST.
 *
 * Shared across slots: user, venv, HF cache, secrets.env.
 * Per slot: systemd unit, serve wrapper, measured.env, port, log, served name.
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { envFilePath } from '../settings/env-store';

import { MAX_DEPLOY_SLOTS } from './limits';
import { deployPort } from './port';

export { MAX_DEPLOY_SLOTS };
export const INSTALL_ROOT = '/opt/redrob-vllm';
export const SECRETS_ENV = '/etc/redrob-vllm/secrets.env';
export const SLOTS_ROOT = '/etc/redrob-vllm/slots';
/** Pre-multi-slot measured.env; migrated to slots/0 on install. */
export const LEGACY_MEASURED_ENV = '/etc/redrob-vllm/measured.env';
/** Pre-multi-slot unit name; disabled on install. */
export const LEGACY_UNIT = 'redrob-vllm.service';

export interface DeploySlot {
  index: number;
  port: number;
  unit: string;
  measuredEnv: string;
  serveScript: string;
  logFile: string;
  servedName: string;
}

export interface DeploySlotRecord {
  index: number;
  hf: string;
  label: string;
  updatedAt: string;
}

export function slotFor(index: number): DeploySlot {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_DEPLOY_SLOTS) {
    throw new Error(`slot index must be 0..${MAX_DEPLOY_SLOTS - 1}, got ${index}`);
  }
  return {
    index,
    port: deployPort() + index,
    unit: `redrob-vllm-s${index}.service`,
    measuredEnv: `${SLOTS_ROOT}/${index}/measured.env`,
    serveScript: `${INSTALL_ROOT}/bin/serve-${index}.sh`,
    logFile: `/var/log/redrob-vllm/serve-${index}.log`,
    servedName: `redrob-s${index}`,
  };
}

export function allSlotIndexes(): number[] {
  return Array.from({ length: MAX_DEPLOY_SLOTS }, (_, i) => i);
}

export function resolveSlotIndex(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 0;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 0 || n >= MAX_DEPLOY_SLOTS) {
    throw new Error(`slot must be an integer 0..${MAX_DEPLOY_SLOTS - 1}`);
  }
  return n;
}

function storeFilePath(): string {
  return path.join(path.dirname(envFilePath()), '.redrob', 'deploy-slots.json');
}

async function readStore(): Promise<DeploySlotRecord[]> {
  try {
    const raw = await readFile(storeFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as { slots?: unknown };
    if (!Array.isArray(parsed.slots)) return [];
    return parsed.slots.filter((s): s is DeploySlotRecord => {
      if (!s || typeof s !== 'object') return false;
      const rec = s as Partial<DeploySlotRecord>;
      return (
        typeof rec.index === 'number' &&
        Number.isInteger(rec.index) &&
        rec.index >= 0 &&
        rec.index < MAX_DEPLOY_SLOTS &&
        typeof rec.hf === 'string' &&
        typeof rec.label === 'string' &&
        typeof rec.updatedAt === 'string'
      );
    });
  } catch {
    return [];
  }
}

async function writeStore(slots: DeploySlotRecord[]): Promise<void> {
  const file = storeFilePath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ slots }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    await chmod(file, 0o600);
  } catch {
    /* Windows / restricted FS */
  }
}

export async function listSlots(): Promise<DeploySlotRecord[]> {
  const slots = await readStore();
  return slots.slice().sort((a, b) => a.index - b.index);
}

export async function upsertSlot(input: {
  index: number;
  hf: string;
  label?: string;
}): Promise<DeploySlotRecord> {
  const slot = slotFor(input.index);
  const hf = input.hf.trim();
  if (!hf) throw new Error('hf is required');
  const short = hf.includes('/') ? hf.split('/').pop()! : hf;
  const record: DeploySlotRecord = {
    index: slot.index,
    hf,
    label: (input.label ?? `Slot ${slot.index}: ${short}`).trim(),
    updatedAt: new Date().toISOString(),
  };
  const slots = await readStore();
  const next = slots.filter((s) => s.index !== record.index);
  next.push(record);
  next.sort((a, b) => a.index - b.index);
  await writeStore(next);
  return record;
}

export async function removeSlotRecord(index: number): Promise<void> {
  slotFor(index); // validate
  const slots = await readStore();
  const next = slots.filter((s) => s.index !== index);
  if (next.length === slots.length) return;
  await writeStore(next);
}

/** Lowest free index not already in the local registry, or null if full. */
export async function nextFreeSlotIndex(): Promise<number | null> {
  const used = new Set((await listSlots()).map((s) => s.index));
  for (const i of allSlotIndexes()) {
    if (!used.has(i)) return i;
  }
  return null;
}
