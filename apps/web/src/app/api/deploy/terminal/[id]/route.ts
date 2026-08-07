import { NextResponse } from 'next/server';
import { detachTerminal, killTerminal, resizeTerminal, writeTerminal } from '@/lib/deploy/sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/deploy/terminal/:id — write input or resize. Body: { data } or { cols, rows }. */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  let body: { data?: string; cols?: number; rows?: number };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (typeof body.cols === 'number' && typeof body.rows === 'number') {
    const ok = resizeTerminal(id, body.cols, body.rows);
    return NextResponse.json({ ok });
  }
  if (typeof body.data === 'string') {
    const ok = writeTerminal(id, body.data);
    if (!ok) return NextResponse.json({ ok: false, error: 'Session closed' }, { status: 410 });
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: 'Provide data or cols/rows' }, { status: 400 });
}

/**
 * DELETE /api/deploy/terminal/:id — detach by default, leaving the tmux
 * session (and any running op) alive on the host. Pass ?kill=1 to end it.
 */
export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const kill = new URL(request.url).searchParams.get('kill') === '1';
  if (kill) {
    await killTerminal(id);
    return NextResponse.json({ ok: true, killed: true });
  }
  const ok = detachTerminal(id);
  return NextResponse.json({ ok, killed: false });
}
