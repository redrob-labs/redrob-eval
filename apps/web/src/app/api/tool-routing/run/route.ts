import {
  baseUrlForServedName,
  loadStubToolRoutingTasks,
  normalizeToolRoutingLanguages,
  probeVllmEndpoint,
  resolveModel,
  runToolRoutingHarness,
  toolRoutingBallotText,
  TOOL_ROUTING_COMPARE_CONDITIONS,
  type ToolRoutingLanguage,
  type ToolRoutingReport,
} from '@redrob/harness';

import { BUILTIN_HOST_ID, resolveVllmHost } from '@/lib/settings/vllm-hosts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** 52 contract prompts per model: two models can still take several minutes. */
export const maxDuration = 800;

type Body = {
  /** Catalog ids from the Compare model picker, e.g. vllm/redrob. */
  modelIds?: unknown;
  /** Registered vLLM host id. Never a URL: the server resolves it. */
  hostId?: unknown;
  /** Selected fixture languages. Defaults to Hindi + romanized Hindi. */
  languages?: unknown;
};

type RunStreamEvent =
  | {
      type: 'start';
      total: number;
      models: Array<{ id: string; label: string }>;
      /** The ballots, so the client can build a tournament without the fixtures. */
      tasks: Array<{ id: string; text: string }>;
    }
  | { type: 'progress'; done: number; total: number; message: string }
  | { type: 'model_done'; modelId: string; label: string; report: ToolRoutingReport }
  | { type: 'model_error'; modelId: string; label: string; message: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

function sseEncode(event: RunStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** What the harness will actually do with one picked model. */
type Plan = {
  catalogId: string;
  label: string;
  providerId: string;
  modelName: string;
  hfRepoId: string | null;
  endpoint?: { baseUrl: string; apiKey: string | null };
  /** Set when the model cannot be run at all; nothing is called for it. */
  blocked: string | null;
};

async function planModel(catalogId: string, hostId: string): Promise<Plan> {
  const resolved = await resolveModel(catalogId);
  if (!resolved) {
    return {
      catalogId,
      label: catalogId,
      providerId: 'unknown',
      modelName: catalogId,
      hfRepoId: null,
      blocked: `unknown model id: ${catalogId}`,
    };
  }

  const base: Plan = {
    catalogId: resolved.canonicalId,
    label: resolved.label,
    providerId: resolved.providerId,
    modelName: resolved.modelId,
    hfRepoId: null,
    blocked: null,
  };

  if (resolved.providerId !== 'vllm') return base;

  const host = await resolveVllmHost(hostId || BUILTIN_HOST_ID);
  if (!host) return { ...base, blocked: `unknown host: ${hostId}` };

  // A self-hosted slot alias (redrob-s1) is only served on its own port, so it
  // is routed there regardless of the picked host. The host is a fallback for
  // names that are not a known slot. Without this every slot was probed on slot
  // 0's port and the second model reported "does not serve redrob-s1".
  const slotBaseUrl = baseUrlForServedName(resolved.modelId);
  const baseUrl = slotBaseUrl ?? host.baseUrl;
  const apiKey = host.apiKey;

  // Fail before spending calls. An endpoint that is down otherwise produces a
  // full report of 0% accuracy, which reads as a verdict on the model rather
  // than on a missing server.
  const probe = await probeVllmEndpoint({
    baseUrl,
    apiKey,
    servedModelId: resolved.modelId,
    timeoutMs: 2500,
  });
  if (!probe.reachable) {
    return {
      ...base,
      blocked: probe.configured
        ? `${host.label} (${probe.baseUrl}) is not answering (${probe.error ?? 'unreachable'})`
        : (probe.error ?? 'vLLM is not configured'),
    };
  }
  if (probe.servedModelFound === false) {
    return {
      ...base,
      blocked: `${probe.baseUrl} does not serve "${resolved.modelId}". It serves: ${probe.servedModels.join(', ')}`,
    };
  }

  // The served name is an alias, so record the weights vLLM launched with
  // rather than the alias the report would otherwise be filed under.
  return {
    ...base,
    hfRepoId: probe.servedModel?.root ?? null,
    endpoint: { baseUrl, apiKey },
  };
}

/**
 * POST /api/tool-routing/run
 * Runs the fixed-toolset routing tasks for every picked model over SSE, so the
 * conditions can be compared across models the same way Compare compares text.
 *
 * Events: start → (progress* → model_done | model_error)* → done | error
 */
export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const modelIds = Array.isArray(body.modelIds)
    ? [...new Set(body.modelIds.filter((v): v is string => typeof v === 'string' && v.trim() !== ''))]
    : [];
  if (modelIds.length === 0) {
    return Response.json({ error: 'modelIds is required' }, { status: 400 });
  }

  const hostId = typeof body.hostId === 'string' ? body.hostId.trim() : '';
  let languages: ToolRoutingLanguage[];
  try {
    languages = normalizeToolRoutingLanguages(body.languages);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'invalid languages' },
      { status: 400 },
    );
  }
  const plans = await Promise.all(modelIds.map((id) => planModel(id, hostId)));
  if (plans.every((p) => p.blocked)) {
    return Response.json(
      { error: `No model can be run. ${plans.map((p) => `${p.label}: ${p.blocked}`).join(' · ')}` },
      { status: 503 },
    );
  }

  const selected = new Set(languages);
  const tasks = loadStubToolRoutingTasks().filter((task) => selected.has(task.language));
  const callsPerModel = tasks.length * TOOL_ROUTING_COMPARE_CONDITIONS.length;
  const total = plans.reduce((sum, p) => sum + (p.blocked ? 0 : callsPerModel), 0);

  const runAbort = new AbortController();
  const onClientAbort = () => runAbort.abort();
  request.signal.addEventListener('abort', onClientAbort);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: RunStreamEvent) => {
        try {
          controller.enqueue(encoder.encode(sseEncode(event)));
        } catch {
          /* client disconnected */
        }
      };

      send({
        type: 'start',
        total,
        models: plans.map((p) => ({ id: p.catalogId, label: p.label })),
        tasks: tasks.map((t) => ({ id: t.id, text: toolRoutingBallotText(t) })),
      });

      let done = 0;
      try {
        for (const plan of plans) {
          if (runAbort.signal.aborted) break;
          if (plan.blocked) {
            send({
              type: 'model_error',
              modelId: plan.catalogId,
              label: plan.label,
              message: plan.blocked,
            });
            continue;
          }

          const offset = done;
          try {
            const report = await runToolRoutingHarness({
              modelId: plan.catalogId,
              hfRepoId: plan.hfRepoId,
              servedModelId: plan.modelName,
              providerId: plan.providerId as never,
              endpoint: plan.endpoint,
              tasks,
              languages,
              conditions: TOOL_ROUTING_COMPARE_CONDITIONS,
              onProgress: (p) => {
                if (runAbort.signal.aborted) return;
                done = offset + p.done;
                send({
                  type: 'progress',
                  done,
                  total,
                  message: `${plan.label} · ${p.message}`,
                });
              },
            });
            done = offset + callsPerModel;
            if (!runAbort.signal.aborted) {
              send({
                type: 'model_done',
                modelId: plan.catalogId,
                label: plan.label,
                report,
              });
            }
          } catch (error) {
            done = offset + callsPerModel;
            send({
              type: 'model_error',
              modelId: plan.catalogId,
              label: plan.label,
              message: error instanceof Error ? error.message : 'run failed',
            });
          }
        }
        if (!runAbort.signal.aborted) send({ type: 'done' });
      } catch (error) {
        send({
          type: 'error',
          message: error instanceof Error ? error.message : 'tool-routing run failed',
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
