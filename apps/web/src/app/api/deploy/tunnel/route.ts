import { NextResponse } from 'next/server';
import { startTunnel, stopTunnel, tunnelState } from '@/lib/deploy/tunnel';
import { deployEnvPresence } from '@/lib/deploy/ssh';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/deploy/tunnel — start SSH local forwards for S/L endpoints. */
export async function POST() {
  const presence = deployEnvPresence();
  const missing = ['GPU_HOST', 'GPU_USER', 'GPU_SSH_KEY'].filter((k) => !presence[k]);
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Missing deploy env: ${missing.join(', ')}` },
      { status: 400 },
    );
  }
  try {
    const state = await startTunnel();
    return NextResponse.json({ ok: true, tunnel: state });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Tunnel failed' },
      { status: 502 },
    );
  }
}

/** DELETE /api/deploy/tunnel — stop forwards. */
export async function DELETE() {
  const state = stopTunnel();
  return NextResponse.json({ ok: true, tunnel: state });
}

/** GET /api/deploy/tunnel — current state. */
export async function GET() {
  return NextResponse.json({ tunnel: tunnelState() });
}
