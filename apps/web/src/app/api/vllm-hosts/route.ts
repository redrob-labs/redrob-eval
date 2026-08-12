import { NextResponse } from 'next/server';

import { ensureSettingsDefaultsApplied } from '@/lib/settings/env-store';
import { isLocalRequest, localOnlyResponse } from '@/lib/settings/local-guard';
import { addVllmHost, listVllmHosts } from '@/lib/settings/vllm-hosts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/vllm-hosts - every endpoint this workbench can call. Keys are never returned. */
export async function GET(request: Request) {
  if (!isLocalRequest(request)) return localOnlyResponse();
  ensureSettingsDefaultsApplied();
  return NextResponse.json({ hosts: await listVllmHosts() });
}

/** POST /api/vllm-hosts - body `{ label, baseUrl, apiKey? }`. */
export async function POST(request: Request) {
  if (!isLocalRequest(request)) return localOnlyResponse();
  ensureSettingsDefaultsApplied();

  let body: { label?: unknown; baseUrl?: unknown; apiKey?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const host = await addVllmHost({
      label: typeof body.label === 'string' ? body.label : '',
      baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : '',
      apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
    });
    return NextResponse.json({ host, hosts: await listVllmHosts() }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to add host' },
      { status: 400 },
    );
  }
}
