import type { EvalStreamEvent } from '@redrob/harness';
import { getModality, type ModalityRunRequest } from '@/lib/modality';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Allow long runs (many model calls, image generation is slow). */
export const maxDuration = 800;

function sseEncode(event: EvalStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

type Body = ModalityRunRequest & { modality?: string };

/**
 * POST /api/compare/run — run one Compare comparison over SSE.
 *
 * Dispatches on `modality` so text, image and later audio all stream the same
 * event shape back to the Compare client.
 */
export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const modality = getModality(body.modality ?? 'text');
  if (!modality) {
    return Response.json({ error: `Unknown modality: ${body.modality}` }, { status: 400 });
  }

  const prompts = (body.prompts ?? []).filter((p) => p?.input?.trim());
  const hasPrompts = prompts.length > 0;
  if (!body.datasetId && !hasPrompts && modality.id === 'text') {
    return Response.json(
      { error: 'Provide either a datasetId or prompts' },
      { status: 400 },
    );
  }
  if (!Array.isArray(body.modelIds) || body.modelIds.length === 0) {
    return Response.json({ error: 'Select at least one model' }, { status: 400 });
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
        for await (const event of modality.run(
          {
            modelIds: body.modelIds,
            datasetId: body.datasetId,
            prompts: hasPrompts ? prompts : undefined,
            promptSetLabel: body.promptSetLabel,
            sampleCount: Number.isFinite(body.sampleCount)
              ? Number(body.sampleCount)
              : Math.max(1, prompts.length),
            suiteId: body.suiteId,
            seed: body.seed,
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
            message: error instanceof Error ? error.message : 'Run failed',
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
