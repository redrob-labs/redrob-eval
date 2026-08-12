import { NextResponse } from 'next/server';

import { ensureSettingsDefaultsApplied } from '@/lib/settings/env-store';
import { isLocalRequest, localOnlyResponse } from '@/lib/settings/local-guard';
import { listVllmHosts, removeVllmHost, updateVllmHost } from '@/lib/settings/vllm-hosts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * PATCH /api/vllm-hosts/[id] - body `{ label?, baseUrl?, apiKey? }`.
 * Omitted fields are untouched; an empty apiKey clears the stored key.
 */
export async function PATCH(request: Request, context: Ctx) {
  if (!isLocalRequest(request)) return localOnlyResponse();
  ensureSettingsDefaultsApplied();
  const { id } = await context.params;

  let body: { label?: unknown; baseUrl?: unknown; apiKey?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const host = await updateVllmHost(id, {
      label: typeof body.label === 'string' ? body.label : undefined,
      baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : undefined,
      apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
    });
    return NextResponse.json({ host, hosts: await listVllmHosts() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update host';
    return NextResponse.json(
      { error: message },
      { status: message.startsWith('Unknown host') ? 404 : 400 },
    );
  }
}

/** DELETE /api/vllm-hosts/[id] */
export async function DELETE(request: Request, context: Ctx) {
  if (!isLocalRequest(request)) return localOnlyResponse();
  ensureSettingsDefaultsApplied();
  const { id } = await context.params;

  try {
    await removeVllmHost(id);
    return NextResponse.json({ ok: true, hosts: await listVllmHosts() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to remove host' },
      { status: 404 },
    );
  }
}
