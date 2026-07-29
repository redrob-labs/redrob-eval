import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { EvalStreamEvent } from '../eval/types';
import { assertSafeRunId, routingRunDir, ensureRoutingDirs } from '../routing-data/fs';
import type { RunManifest } from './manifest';

export async function writeRunManifest(runId: string, manifest: RunManifest): Promise<void> {
  await ensureRoutingDirs();
  const dir = routingRunDir(runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'run_manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

export async function readRunManifest(runId: string): Promise<RunManifest | null> {
  try {
    const raw = await fs.readFile(
      path.join(routingRunDir(assertSafeRunId(runId)), 'run_manifest.json'),
      'utf8',
    );
    return JSON.parse(raw) as RunManifest;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export async function appendProgressEvent(
  runId: string,
  event: EvalStreamEvent,
): Promise<void> {
  await ensureRoutingDirs();
  const dir = routingRunDir(runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(
    path.join(dir, 'progress.jsonl'),
    `${JSON.stringify(event)}\n`,
    'utf8',
  );
}

export async function readProgressEvents(
  runId: string,
  fromLine = 0,
): Promise<{ events: EvalStreamEvent[]; nextLine: number }> {
  try {
    const raw = await fs.readFile(
      path.join(routingRunDir(assertSafeRunId(runId)), 'progress.jsonl'),
      'utf8',
    );
    const lines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const slice = lines.slice(fromLine);
    const events = slice.map((l) => JSON.parse(l) as EvalStreamEvent);
    return { events, nextLine: fromLine + slice.length };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { events: [], nextLine: fromLine };
    }
    throw e;
  }
}

/** Update meta.status helper used by the job worker. */
export async function writeJobStatus(
  runId: string,
  status: 'queued' | 'running' | 'ready' | 'failed' | 'stopped',
  patch?: Record<string, unknown>,
): Promise<void> {
  const metaPath = path.join(routingRunDir(runId), 'meta.json');
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) as Record<string, unknown>;
  } catch {
    /* new job */
  }
  const next: Record<string, unknown> = { ...meta, ...patch, status, runId };
  if (status === 'ready' || status === 'failed' || status === 'stopped') {
    next.finishedAt = new Date().toISOString();
  }
  await fs.mkdir(routingRunDir(runId), { recursive: true });
  await fs.writeFile(metaPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}
