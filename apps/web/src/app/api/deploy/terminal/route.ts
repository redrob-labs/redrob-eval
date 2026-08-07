import { NextResponse } from 'next/server';
import { MAIN_TERMINAL_ID, ensureTerminal, terminalState } from '@/lib/deploy/sessions';
import { deployEnvPresence } from '@/lib/deploy/ssh';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function missingSshEnv(): string[] {
  const presence = deployEnvPresence();
  return ['GPU_HOST', 'GPU_USER', 'GPU_SSH_KEY'].filter((k) => !presence[k]);
}

/**
 * GET /api/deploy/terminal — current session state, so the browser can decide
 * whether to reattach before opening anything.
 */
export async function GET() {
  return NextResponse.json(terminalState(MAIN_TERMINAL_ID));
}

/**
 * POST /api/deploy/terminal — attach to the persistent shell, opening it only
 * if it is not already live. Idempotent: reloading the page reattaches to the
 * running tmux session instead of starting a second one.
 * Body (optional): { cols, rows }
 */
export async function POST(request: Request) {
  const missing = missingSshEnv();
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Missing deploy env: ${missing.join(', ')}` },
      { status: 400 },
    );
  }
  let size: { cols?: number; rows?: number } = {};
  try {
    const body = (await request.json()) as { cols?: number; rows?: number };
    if (typeof body?.cols === 'number' && typeof body?.rows === 'number') {
      size = { cols: body.cols, rows: body.rows };
    }
  } catch {
    /* body is optional */
  }
  try {
    const { id, reused } = await ensureTerminal(size);
    return NextResponse.json({ ...terminalState(id), reused });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to open shell' },
      { status: 502 },
    );
  }
}
