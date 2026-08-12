import { NextResponse } from 'next/server';
import { listSelfHostedModels } from '@redrob/harness';
import { deployEnvPresence, sshExec } from '@/lib/deploy/ssh';
import {
  applyRemoteMeasured,
  attachSlotReachability,
  buildSlotStatusViews,
  parseStatus,
} from '@/lib/deploy/operations';
import { statusScript } from '@/lib/deploy/remote';
import { deployPort } from '@/lib/deploy/port';
import { INSTALL_ROOT, listSlots } from '@/lib/deploy/slots';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Hard ceiling on the remote SSH round-trip.
 *
 * env presence and sshReady are computed locally and are all the page needs to leave its
 * "checking…" state. The remote GPU status is best-effort, so a slow or hanging host must
 * never block the response — otherwise the page's initial poll never resolves and the
 * spinner stays up forever. Shorter than ssh.ts `readyTimeout` (20s) on purpose.
 */
const REMOTE_STATUS_TIMEOUT_MS = 8_000;

/**
 * GET /api/deploy/status
 * Returns env presence (booleans only, never secret values), self-hosted
 * catalog metadata, per-slot remote status, and (best-effort) GPU facts.
 */
function modelSnapshot() {
  return listSelfHostedModels().map((m) => ({
    id: m.id,
    label: m.label,
    tier: m.tier ?? null,
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
  const localSlots = await listSlots();

  let remote: Record<string, string> | null = null;
  let remoteError: string | null = null;
  if (sshReady) {
    try {
      const res = await sshExec(statusScript(), {
        sudo: false,
        signal: AbortSignal.timeout(REMOTE_STATUS_TIMEOUT_MS),
      });
      remote = parseStatus(res.stdout);
      // measured.env on the host is the only source of util / precision / tok/s
      await applyRemoteMeasured(remote);
    } catch (error) {
      remoteError =
        error instanceof Error && (error.name === 'TimeoutError' || error.message === 'aborted')
          ? `GPU host did not respond within ${REMOTE_STATUS_TIMEOUT_MS / 1000}s`
          : error instanceof Error
            ? error.message
            : 'status failed';
    }
  }

  const host =
    process.env.GPU_HOST?.trim() || remote?.HOST?.trim() || null;
  const installRoot = remote?.INSTALL_ROOT?.trim() || INSTALL_ROOT;
  const slots = await attachSlotReachability(
    buildSlotStatusViews(remote, localSlots),
    host,
  );

  return NextResponse.json({
    env: presence,
    sshReady,
    host,
    installRoot,
    port: deployPort(),
    portBase: deployPort(),
    // Where Eval and Compare will call. Not a secret: it is the host the user
    // typed into Settings, and seeing it is how they catch a stale override.
    endpoint: process.env.VLLM_BASE_URL?.trim() || null,
    // Built after applyRemoteMeasured so weights reflect the latest tok/s
    models: modelSnapshot(),
    slots,
    localSlots,
    remote,
    remoteError,
  });
}
