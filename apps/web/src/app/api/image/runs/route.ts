import {
  listRunIds,
  readRunMeta,
  runImagePreference,
  type ImageEvalRunRequest,
  type ImageRunStreamEvent,
} from '@/lib/image-eval';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 800;

function sseEncode(event: ImageRunStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** GET /api/image/runs — list recent image preference runs */
export async function GET() {
  const ids = await listRunIds();
  const runs = [];
  for (const id of ids.slice(0, 40)) {
    try {
      runs.push(await readRunMeta(id));
    } catch {
      // skip corrupt
    }
  }
  return Response.json({ runs });
}

/**
 * POST /api/image/runs — generate images (+ optional auto-judge) via SSE
 */
export async function POST(request: Request) {
  let body: ImageEvalRunRequest;
  try {
    body = (await request.json()) as ImageEvalRunRequest;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!body.suiteId) {
    return new Response(JSON.stringify({ error: 'Provide suiteId' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const runAbort = new AbortController();
  const onClientAbort = () => runAbort.abort();
  request.signal.addEventListener('abort', onClientAbort);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: ImageRunStreamEvent) => {
        try {
          controller.enqueue(encoder.encode(sseEncode(event)));
        } catch {
          // client disconnected
        }
      };

      try {
        for await (const event of runImagePreference(
          {
            suiteId: body.suiteId,
            modelIds: Array.isArray(body.modelIds) ? body.modelIds : [],
            seed: body.seed,
            promptLimit: body.promptLimit,
            autoJudge: Boolean(body.autoJudge),
            judgeModelId: body.judgeModelId,
          },
          { signal: runAbort.signal },
        )) {
          send(event);
          if (event.type === 'error' || event.type === 'cancelled') break;
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          send({ type: 'cancelled', message: 'Stopped' });
        } else {
          send({
            type: 'error',
            message: error instanceof Error ? error.message : 'Image eval failed',
          });
        }
      } finally {
        request.signal.removeEventListener('abort', onClientAbort);
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
    cancel() {
      runAbort.abort();
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
