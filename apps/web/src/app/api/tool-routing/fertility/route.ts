import {
  listToolRoutingModels,
  loadStubFertilityCorpus,
  measureToolRoutingFertility,
  normalizeToolRoutingLanguages,
  type FertilityCell,
  type ToolRoutingLanguage,
} from '@redrob/harness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type FertilityStreamEvent =
  | { type: 'start'; total: number }
  | { type: 'progress'; done: number; total: number; message: string }
  | { type: 'cell'; cell: FertilityCell }
  | { type: 'done'; cells: FertilityCell[] }
  | { type: 'error'; message: string };

function sseEncode(event: FertilityStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * POST /api/tool-routing/fertility
 * Tokenizer-only SSE stream. No inference. First run downloads HF tokenizers.
 *
 * Body: { includeEvalOnly?: boolean, languages?: ToolRoutingLanguage[] }
 * Events: start → progress/cell* → done | error
 */
export async function POST(request: Request) {
  let includeEvalOnly = false;
  let languageInput: unknown;
  try {
    const body = (await request.json()) as { includeEvalOnly?: unknown; languages?: unknown };
    includeEvalOnly = body.includeEvalOnly === true;
    languageInput = body.languages;
  } catch {
    /* empty body is fine */
  }
  let languages: ToolRoutingLanguage[];
  try {
    languages = normalizeToolRoutingLanguages(languageInput);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'invalid languages' },
      { status: 400 },
    );
  }

  const runAbort = new AbortController();
  const onClientAbort = () => runAbort.abort();
  request.signal.addEventListener('abort', onClientAbort);

  const models = listToolRoutingModels({ includeEvalOnly });
  const total = models.length * languages.length;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: FertilityStreamEvent) => {
        try {
          controller.enqueue(encoder.encode(sseEncode(event)));
        } catch {
          /* client disconnected */
        }
      };

      send({ type: 'start', total });

      try {
        const corpus = loadStubFertilityCorpus();
        const cells = await measureToolRoutingFertility({
          corpus,
          models,
          languages,
          includeEvalOnly,
          onProgress: (p) => {
            if (runAbort.signal.aborted) return;
            send({
              type: 'progress',
              done: p.done,
              total: p.total,
              message: p.message,
            });
          },
          onCell: (cell) => {
            if (runAbort.signal.aborted) return;
            send({ type: 'cell', cell });
          },
        });
        if (!runAbort.signal.aborted) {
          send({ type: 'done', cells });
        }
      } catch (error) {
        send({
          type: 'error',
          message:
            error instanceof Error ? error.message : 'fertility measurement failed',
        });
      } finally {
        request.signal.removeEventListener('abort', onClientAbort);
        try {
          controller.close();
        } catch {
          /* already closed */
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
