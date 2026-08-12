import { NextResponse } from 'next/server';
import { probeVllmEndpoint } from '@redrob/harness';

import { ensureSettingsDefaultsApplied } from '@/lib/settings/env-store';
import { isLocalRequest, localOnlyResponse } from '@/lib/settings/local-guard';
import { resolveVllmHost } from '@/lib/settings/vllm-hosts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/vllm-hosts/[id]/probe?servedModelId=redrob
 *
 * Whether this host actually answers, and which names it serves. The single
 * place both Settings and Compare check an endpoint, so "is it up" cannot
 * drift between them. The client sends an id; the URL is resolved here.
 */
export async function GET(request: Request, context: Ctx) {
  if (!isLocalRequest(request)) return localOnlyResponse();
  ensureSettingsDefaultsApplied();

  const { id } = await context.params;
  const host = await resolveVllmHost(id);
  if (!host) {
    return NextResponse.json({ error: `Unknown host: ${id}` }, { status: 404 });
  }

  const servedModelId =
    new URL(request.url).searchParams.get('servedModelId')?.trim() || undefined;

  const probe = await probeVllmEndpoint({
    baseUrl: host.baseUrl,
    apiKey: host.apiKey,
    servedModelId,
    timeoutMs: 2500,
  });

  return NextResponse.json(
    { hostId: host.id, hostLabel: host.label, ...probe },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
