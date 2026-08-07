import { NextResponse } from 'next/server';
import {
  injectHelperIntoTerminal,
  injectOpIntoTerminal,
  type DeployOp,
} from '@/lib/deploy/operations';
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
]);

const HELPERS = new Set(['tail-s', 'tail-l', 'gpu', 'interrupt'] as const);

/**
 * POST /api/deploy/terminal/:id/inject
 * Body: { op } or { helper }
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
    axisS?: string;
    axisL?: string;
    hfS?: string;
    hfL?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    if (body.helper && HELPERS.has(body.helper as 'tail-s')) {
      injectHelperIntoTerminal(
        id,
        body.helper as 'tail-s' | 'tail-l' | 'gpu' | 'interrupt',
      );
      return NextResponse.json({ ok: true, helper: body.helper });
    }

    const op = body.op as DeployOp | undefined;
    if (!op || !OPS.has(op)) {
      return NextResponse.json({ error: 'Provide op or helper' }, { status: 400 });
    }
    if ((op === 'install' || op === 'measure') && !presence.HF_TOKEN) {
      return NextResponse.json(
        {
          error:
            'HF_TOKEN required — set it in Settings (create at huggingface.co/settings/tokens), then retry.',
          code: 'HF_TOKEN_REQUIRED',
          settingsPath: '/settings#HF_TOKEN',
        },
        { status: 400 },
      );
    }

    const result = await injectOpIntoTerminal(id, op, {
      axisSKey: body.axisS,
      axisLKey: body.axisL,
      hfS: body.hfS,
      hfL: body.hfL,
    });
    return NextResponse.json({
      ok: true,
      op,
      label: result.label,
      modelS: result.cfg.modelS,
      modelL: result.cfg.modelL,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Inject failed' },
      { status: 502 },
    );
  }
}
