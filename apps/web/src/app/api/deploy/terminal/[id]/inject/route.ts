import { NextResponse } from 'next/server';
import {
  injectHelperIntoTerminal,
  injectOpIntoTerminal,
  type DeployOp,
} from '@/lib/deploy/operations';
import { resolveSlotIndex } from '@/lib/deploy/slots';
import { deployEnvPresence } from '@/lib/deploy/ssh';
import { ensureSettingsDefaultsApplied, ensureVllmApiKey } from '@/lib/settings/env-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const OPS = new Set<DeployOp>([
  'install',
  'measure',
  'start',
  'stop',
  'health',
  'benchmark',
  'undeploy',
  'purge',
]);

const HELPERS = new Set(['tail', 'gpu', 'interrupt'] as const);

/**
 * POST /api/deploy/terminal/:id/inject
 * Body: { op, slot?, modelKey?, hf? } or { helper, slot? }
 * Drops the op script on the host (SFTP) and types the run command into the
 * open remote shell so output streams live and Ctrl+C works.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  ensureSettingsDefaultsApplied();
  await ensureVllmApiKey();
  const presence = deployEnvPresence();
  const missing = ['GPU_HOST', 'GPU_USER', 'GPU_SSH_KEY'].filter((k) => !presence[k]);
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Missing deploy env: ${missing.join(', ')}. Set them in Settings.` },
      { status: 400 },
    );
  }

  let body: {
    op?: string;
    helper?: string;
    /** Catalog key of the one model to serve. */
    modelKey?: string;
    /** HF repo id, when the model came from a pasted link rather than the catalog. */
    hf?: string;
    /** Deploy slot index (0..MAX-1). Defaults to 0. */
    slot?: number;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  let slot = 0;
  try {
    slot = resolveSlotIndex(body.slot);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid slot' },
      { status: 400 },
    );
  }

  try {
    if (body.helper && HELPERS.has(body.helper as 'tail')) {
      injectHelperIntoTerminal(id, body.helper as 'tail' | 'gpu' | 'interrupt', slot);
      return NextResponse.json({ ok: true, helper: body.helper, slot });
    }

    const op = body.op as DeployOp | undefined;
    if (!op || !OPS.has(op)) {
      return NextResponse.json({ error: 'Provide op or helper' }, { status: 400 });
    }
    if ((op === 'install' || op === 'measure') && !presence.HF_TOKEN) {
      return NextResponse.json(
        {
          error:
            'HF_TOKEN required. Set it in Settings (create at huggingface.co/settings/tokens), then retry.',
          code: 'HF_TOKEN_REQUIRED',
          settingsPath: '/settings#HF_TOKEN',
        },
        { status: 400 },
      );
    }

    const result = await injectOpIntoTerminal(id, op, {
      modelKey: body.modelKey,
      hf: body.hf,
      slot,
    });
    return NextResponse.json({
      ok: true,
      op,
      slot,
      label: result.label,
      model: result.cfg.model,
      servedName: result.cfg.servedName,
      port: result.cfg.slot.port,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Inject failed' },
      { status: 502 },
    );
  }
}
