import { runEval, type EvalRunRequest } from '@redrob/harness';
import type { EvalStreamEvent } from '@redrob/harness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Allow longer evals (many model calls). */
export const maxDuration = 800;

function sseEncode(event: EvalStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * POST /api/eval — run eval with Server-Sent Events progress.
 *
 * Body:
 * {
 *   datasetId, sampleCount,
 *   modelIds: string[],
 *   includeRouter?: boolean,
 *   routerSmallId?: string,
 *   routerLargeId?: string,
 *   largeBaselineId?: string
 * }
 */
export async function POST(request: Request) {
  let body: EvalRunRequest;
  try {
    body = (await request.json()) as EvalRunRequest;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!body.datasetId || !Number.isFinite(body.sampleCount)) {
    return new Response(
      JSON.stringify({ error: 'Provide datasetId and sampleCount' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const runAbort = new AbortController();
  const onClientAbort = () => runAbort.abort();
  request.signal.addEventListener('abort', onClientAbort);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: EvalStreamEvent) => {
        try {
          controller.enqueue(encoder.encode(sseEncode(event)));
        } catch {
          // client disconnected
        }
      };

      try {
        for await (const event of runEval(
          {
            datasetId: body.datasetId,
            sampleCount: body.sampleCount,
            modelIds: Array.isArray(body.modelIds) ? body.modelIds : [],
            includeRouter: Boolean(body.includeRouter),
            routerSmallId: body.routerSmallId,
            routerLargeId: body.routerLargeId,
            largeBaselineId: body.largeBaselineId,
          },
          { signal: runAbort.signal },
        )) {
          if (runAbort.signal.aborted) {
            send({ type: 'cancelled', message: 'Stopped' });
            break;
          }
          send(event);
          if (event.type === 'error' || event.type === 'cancelled') break;
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          send({ type: 'cancelled', message: 'Stopped' });
        } else {
          send({
            type: 'error',
            message: error instanceof Error ? error.message : 'Eval failed',
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
