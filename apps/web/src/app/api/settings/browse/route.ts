import { NextResponse } from 'next/server';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isLocalRequest, localOnlyResponse } from '@/lib/settings/local-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_ENTRIES = 500;

interface Entry {
  name: string;
  path: string;
  isDir: boolean;
}

/**
 * GET /api/settings/browse?dir=<abs path>
 * Lists a local directory (name + isDir only). No per-entry stat — on Windows
 * that can hang on OneDrive placeholders / broken links.
 * Loopback only. File contents are never read.
 */
export async function GET(request: Request) {
  if (!isLocalRequest(request)) return localOnlyResponse();

  const url = new URL(request.url);
  const home = os.homedir();
  const requested = url.searchParams.get('dir')?.trim();
  const dir = requested && requested.length > 0 ? path.resolve(requested) : home;

  let entries: Entry[] = [];
  let error: string | null = null;
  try {
    const dirents = await readdir(dir, { withFileTypes: true });
    entries = dirents.slice(0, MAX_ENTRIES).map((d) => ({
      name: d.name,
      path: path.join(dir, d.name),
      isDir: d.isDirectory(),
    }));
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  } catch (e) {
    error = e instanceof Error ? e.message : 'Cannot read directory';
  }

  const parent = path.dirname(dir);
  return NextResponse.json({
    dir,
    parent: parent === dir ? null : parent,
    home,
    sshDir: path.join(home, '.ssh'),
    truncated: entries.length >= MAX_ENTRIES,
    entries,
    error,
  });
}
