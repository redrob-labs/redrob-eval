import { NextResponse } from 'next/server';
import type { ProviderId } from '@redrob/harness';
import { resolveEvalModel } from '@redrob/harness';
import { callModel, ProviderError } from '@redrob/harness';

const PROVIDER_IDS = new Set<ProviderId>([
  'openrouter',
  'openai',
  'anthropic',
  'google',
  'together',
  'fireworks',
]);

type ProbeBody = {
  /** Catalog model id (curated or or/<openrouter-slug>) */
  evalModelId?: string;
  /** Or pass providerId + modelId directly */
  providerId?: ProviderId;
  modelId?: string;
  prompt?: string;
};

/**
 * Minimal live call to verify provider wiring.
 * Uses server env keys only — do not send API keys in the body.
 */
export async function POST(request: Request) {
  let body: ProbeBody;
  try {
    body = (await request.json()) as ProbeBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const prompt =
    body.prompt?.trim() ||
    'Reply with exactly: ok';

  let providerId: ProviderId | undefined;
  let modelId: string | undefined;

  if (body.evalModelId) {
    const ref = await resolveEvalModel(body.evalModelId);
    if (!ref) {
      return NextResponse.json(
        { error: `Unknown evalModelId: ${body.evalModelId}` },
        { status: 400 },
      );
    }
    providerId = ref.providerId;
    modelId = ref.modelId;
  } else {
    providerId = body.providerId;
    modelId = body.modelId;
  }

  if (!providerId || !PROVIDER_IDS.has(providerId) || !modelId?.trim()) {
    return NextResponse.json(
      {
        error:
          'Provide evalModelId, or both providerId and modelId. Example: { "evalModelId": "or-gpt-4o-mini" }',
      },
      { status: 400 },
    );
  }

  try {
    const result = await callModel(providerId, modelId, prompt, {
      maxTokens: 64,
      temperature: 0,
    });
    return NextResponse.json({
      ok: true,
      providerId: result.providerId,
      modelId: result.modelId,
      latencyMs: result.latencyMs,
      inputTokens: result.inputTokens ?? null,
      outputTokens: result.outputTokens ?? null,
      text: result.text,
    });
  } catch (error) {
    if (error instanceof ProviderError) {
      return NextResponse.json(
        {
          ok: false,
          error: error.message,
          providerId: error.providerId,
          status: error.status ?? null,
        },
        { status: error.status && error.status >= 400 && error.status < 600 ? error.status : 502 },
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Probe failed',
      },
      { status: 502 },
    );
  }
}
