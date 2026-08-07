import { NextResponse } from 'next/server';
import { listSelfHostedModels } from '@redrob/harness';
import { deployEnvPresence, sshExec } from '@/lib/deploy/ssh';
import { applyRemoteMeasured, parseStatus } from '@/lib/deploy/operations';
import { statusScript } from '@/lib/deploy/remote';
import { tunnelState } from '@/lib/deploy/tunnel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/deploy/status
 * Returns env presence (booleans only — never secret values), tunnel state,
 * self-hosted catalog metadata, and (best-effort) remote service + GPU status.
 */
function modelSnapshot() {
  return listSelfHostedModels().map((m) => ({
    id: m.id,
    label: m.label,
    axis: m.selfHosted?.axis ?? null,
    hfRepoId: m.selfHosted?.hfRepoId ?? null,
    license: m.selfHosted?.license ?? null,
    precision: m.selfHosted?.precision ?? null,
    maxModelLen: m.selfHosted?.maxModelLen ?? null,
    servedModelName: m.selfHosted?.servedModelName ?? null,
    measuredTokPerSec: m.selfHosted?.measuredTokPerSec ?? null,
    relativeCostWeight: m.relativeCostWeight,
  }));
}

export async function GET() {
  const presence = deployEnvPresence();
  const sshReady = presence.GPU_HOST && presence.GPU_USER && presence.GPU_SSH_KEY;

  let remote: Record<string, string> | null = null;
  let remoteError: string | null = null;
  if (sshReady) {
    try {
      const res = await sshExec(statusScript(), { sudo: false });
      remote = parseStatus(res.stdout);
      // measured.env on the host is the only source of util / precision / tok/s
      await applyRemoteMeasured(remote);
    } catch (error) {
      remoteError = error instanceof Error ? error.message : 'status failed';
    }
  }

  return NextResponse.json({
    env: presence,
    sshReady,
    tunnel: tunnelState(),
    // Built after applyRemoteMeasured so weights reflect the latest tok/s
    models: modelSnapshot(),
    remote,
    remoteError,
  });
}
