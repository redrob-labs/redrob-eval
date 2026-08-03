import {
  assertSafePreferenceRunId,
  readPreferenceEvents,
  readPreferenceMeta,
  type PreferenceProgressEvent,
} from '@redrob/harness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 800;

function sseEncode(event: PreferenceProgressEvent, id?: number): string {
  const idLine = id != null ? `id: ${id}\n` : '';
  return `${idLine}data: ${JSON.stringify(event)}\n\n`;
}

const TERMINAL = new Set(['done', 'cancelled', 'error']);

/** GET /api/preference/runs/:runId/events — SSE replay + live tail */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId: raw } = await ctx.params;
  let runId: string;
  try {
    runId = assertSafePreferenceRunId(raw);
  } catch {
    return Response.json({ error: 'Invalid run id' }, { status: 400 });
  }

  try {
    await readPreferenceMeta(runId);
  } catch {
    return Response.json({ error: 'Run not found' }, { status: 404 });
  }

  const url = new URL(request.url);
  const lastEventHeader = request.headers.get('Last-Event-ID');
  let fromLine = Number(url.searchParams.get('from') ?? lastEventHeader ?? '0');
  if (!Number.isFinite(fromLine) || fromLine < 0) fromLine = 0;

  const runAbort = new AbortController();
  const onClientAbort = () => runAbort.abort();
  request.signal.addEventListener('abort', onClientAbort);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let cursor = fromLine;
      const send = (event: PreferenceProgressEvent, lineNo: number) => {
        try {
          controller.enqueue(encoder.encode(sseEncode(event, lineNo)));
        } catch {
          // disconnected
        }
      };

      try {
        let idleRounds = 0;
        while (!runAbort.signal.aborted) {
          const { events, nextLine } = await readPreferenceEvents(runId, cursor);
          for (let i = 0; i < events.length; i++) {
            const event = events[i]!;
            send(event, cursor + i);
            if (TERMINAL.has(event.type)) return;
          }
          cursor = nextLine;

          if (events.length === 0) {
            const meta = await readPreferenceMeta(runId);
            if (
              meta.status === 'ready' ||
              meta.status === 'failed' ||
              meta.status === 'stopped'
            ) {
              idleRounds += 1;
              if (idleRounds > 2) return;
            }
          } else {
            idleRounds = 0;
          }

          await new Promise((r) => setTimeout(r, 400));
        }
      } finally {
        request.signal.removeEventListener('abort', onClientAbort);
        try {
          controller.close();
        } catch {
          // ignore
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
