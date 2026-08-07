import { NextResponse } from 'next/server';
import { canonicalIdForRef, EVAL_MODELS, PROVIDER_LABELS } from '@redrob/harness';
import { listProviders } from '@redrob/harness';

/** Server-only status: which providers have keys — never returns key values. */
export async function GET() {
  const providers = listProviders().map((p) => ({
    id: p.id,
    label: PROVIDER_LABELS[p.id],
    configured: p.configured,
  }));

  const models = EVAL_MODELS.map((m) => {
    const provider = providers.find((p) => p.id === m.providerId);
    return {
      id: canonicalIdForRef(m),
      label: m.label,
      providerId: m.providerId,
      modelId: m.modelId,
      relativeCostWeight: m.relativeCostWeight,
      tier: m.tier ?? null,
      callable: Boolean(provider?.configured),
      selfHosted: m.selfHosted
        ? {
            axis: m.selfHosted.axis,
            precision: m.selfHosted.precision,
            license: m.selfHosted.license,
            hfRepoId: m.selfHosted.hfRepoId,
            maxModelLen: m.selfHosted.maxModelLen,
          }
        : null,
    };
  });

  return NextResponse.json({
    port: 3939,
    providers,
    models,
  });
}
