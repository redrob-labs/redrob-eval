import { subscribeTerminal, terminalExists, type Chunk } from '@/lib/deploy/sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 3600;

const HEARTBEAT_MS = 15_000;

/** Resume point: EventSource sends Last-Event-ID automatically on reconnect. */
function readCursor(request: Request): number | null {
  const header = request.headers.get('last-event-id');
  const query = new URL(request.url).searchParams.get('since');
  const raw = header ?? query;
  if (raw === null || raw === '') return null;
  const seq = Number(raw);
  return Number.isFinite(seq) && seq >= 0 ? seq : null;
}

/**
 * GET /api/deploy/terminal/:id/output — SSE stream of shell output.
 * Sends only what the reader is missing: a fresh attach replays the whole
 * buffer, a reconnect with a cursor gets just the gap, so reconnecting never
 * duplicates the log.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!terminalExists(id)) {
    return new Response(JSON.stringify({ error: 'Session not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const since = readCursor(request);
  const abort = new AbortController();
  request.signal.addEventListener('abort', () => abort.abort());

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const enqueue = (payload: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          closed = true;
        }
      };
      const send = (chunk: Chunk) => {
        enqueue(`id: ${chunk.seq}\ndata: ${JSON.stringify(chunk.data)}\n\n`);
      };

      const sub = subscribeTerminal(id, since, send);
      if (!sub) {
        try {
          controller.close();
        } catch {
          /* closed */
        }
        return;
      }
      for (const chunk of sub.replay) send(chunk);

      // Keeps idle streams alive through proxies without touching the cursor.
      const heartbeat = setInterval(() => enqueue(`: ping\n\n`), HEARTBEAT_MS);

      const onAbort = () => {
        closed = true;
        clearInterval(heartbeat);
        sub.unsubscribe();
        try {
          controller.close();
        } catch {
          /* closed */
        }
      };
      abort.signal.addEventListener('abort', onAbort);
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
