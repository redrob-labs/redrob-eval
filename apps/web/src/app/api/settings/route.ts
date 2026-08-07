import { NextResponse } from 'next/server';
import { listProviders, PROVIDER_LABELS } from '@redrob/harness';
import {
  ensureSettingsDefaultsApplied,
  envFilePath,
  readSettings,
  updateSettings,
} from '@/lib/settings/env-store';
import { isLocalRequest, localOnlyResponse } from '@/lib/settings/local-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/settings — editable env for this workbench.
 * Secret values are masked; only set/unset plus a 4-char tail is returned.
 * Plain fields with defaults report the effective value when unset.
 */
export async function GET(request: Request) {
  if (!isLocalRequest(request)) return localOnlyResponse();
  ensureSettingsDefaultsApplied();

  const providers = listProviders().map((p) => ({
    id: p.id,
    label: PROVIDER_LABELS[p.id],
    configured: p.configured,
  }));

  return NextResponse.json({
    settings: readSettings(),
    providers,
    envFile: envFilePath(),
  });
}

/**
 * POST /api/settings — body `{ updates: { KEY: value } }`.
 * Applies to process.env immediately and persists to the repo-root .env.
 * An empty string removes the key.
 */
export async function POST(request: Request) {
  if (!isLocalRequest(request)) return localOnlyResponse();
  ensureSettingsDefaultsApplied();

  let body: { updates?: Record<string, string> };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body.updates || typeof body.updates !== 'object') {
    return NextResponse.json({ error: 'Provide updates object' }, { status: 400 });
  }

  try {
    const { file, applied } = await updateSettings(body.updates);
    return NextResponse.json({
      ok: true,
      applied,
      envFile: file,
      settings: readSettings(),
      providers: listProviders().map((p) => ({
        id: p.id,
        label: PROVIDER_LABELS[p.id],
        configured: p.configured,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to save settings' },
      { status: 500 },
    );
  }
}
