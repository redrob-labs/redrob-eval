import { NextResponse } from 'next/server';
import { cancelScript } from '@/lib/deploy/remote';
import { deployEnvPresence, sshExec } from '@/lib/deploy/ssh';
import { MAIN_TERMINAL_ID, terminalExists, writeTerminal } from '@/lib/deploy/sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Long enough for the script's own trap to release the GPU before we force it. */
const GRACE_MS = 1500;
const CANCEL_TIMEOUT_MS = 20_000;

/**
 * POST /api/deploy/cancel - stop the step running on the GPU host.
 *
 * Ctrl+C first, so the op script's trap shuts its probes down cleanly and
 * prints why it stopped. Then a separate SSH exec sweeps up, because a pane
 * that has already died cannot receive a keystroke, and sudo with use_pty puts
 * the command in its own session where the terminal's SIGINT never lands.
 */
export async function POST() {
  const presence = deployEnvPresence();
  const missing = ['GPU_HOST', 'GPU_USER', 'GPU_SSH_KEY'].filter((k) => !presence[k]);
  if (missing.length > 0) {
    return NextResponse.json({ error: `Missing deploy env: ${missing.join(', ')}` }, { status: 400 });
  }

  let interrupted = false;
  if (terminalExists(MAIN_TERMINAL_ID)) {
    interrupted = writeTerminal(MAIN_TERMINAL_ID, '\x03');
    if (interrupted) await new Promise((r) => setTimeout(r, GRACE_MS));
  }

  try {
    const res = await sshExec(cancelScript(), {
      sudo: true,
      signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS),
    });
    if (!res.stdout.includes('CANCEL_OK')) {
      return NextResponse.json(
        { error: res.stderr.trim() || 'Cancel did not confirm', interrupted },
        { status: 502 },
      );
    }
    return NextResponse.json({
      ok: true,
      interrupted,
      /** False means nothing was still running: the step had already stopped. */
      killed: res.stdout.includes('CANCEL_HIT=1'),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Cancel failed', interrupted },
      { status: 502 },
    );
  }
}
