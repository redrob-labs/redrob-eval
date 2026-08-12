/**
 * What the self-hosted endpoint is serving right now.
 *
 * The catalog row for vLLM is built from SELF_HOSTED_DEFAULTS, which is a guess
 * about the deploy slot, not a fact about it. Deploy can swap the model behind
 * the fixed served name at any time, and then Compare would keep naming the old
 * one. vLLM reports the launch argument as `root` on /v1/models, so ask.
 *
 * Cached: /api/models is hit on every picker keystroke and this is a network
 * round trip to a GPU host that may be powered off.
 */

import {
  SELF_HOSTED_CANDIDATES,
  SERVED_MODEL_NAME,
  vllmSlotEndpoints,
  type SelfHostedMeta,
} from '../../config/self-hosted';
import { probeVllmEndpoint } from '../providers/vllm';

export interface LiveSelfHostedModel {
  /** The endpoint answered /v1/models. */
  reachable: boolean;
  baseUrl: string;
  /** The alias the endpoint answers to, normally `redrob`. */
  servedModelName: string;
  /** Weights behind the alias. Null when unreachable or when vLLM omits `root`. */
  hfRepoId: string | null;
  /** Catalog label for those weights, or the repo id when it is not a candidate. */
  label: string | null;
  /** The endpoint's own --max-model-len, which beats the catalog default. */
  maxModelLen: number | null;
  error: string | null;
  checkedAt: number;
}

const OK_TTL_MS = 60_000;
/** A down host is retried sooner: the usual reason is that Deploy is mid-start. */
const FAIL_TTL_MS = 20_000;
const PROBE_TIMEOUT_MS = 2_000;
const SLOT_PROBE_TIMEOUT_MS = 5_000;

let cache: LiveSelfHostedModel | null = null;
/** Coalesces the burst of parallel /api/models calls a page load produces. */
let inFlight: Promise<LiveSelfHostedModel> | null = null;

function candidateForRepo(hfRepoId: string) {
  return Object.values(SELF_HOSTED_CANDIDATES).find((c) => c.hfRepoId === hfRepoId);
}

/** Candidate label for a repo id, without the suffix every row on the page shares. */
function labelForRepo(hfRepoId: string): string {
  const hit = candidateForRepo(hfRepoId);
  return hit ? hit.label.replace(/\s*\(self-hosted\)$/, '') : hfRepoId;
}

function isFresh(entry: LiveSelfHostedModel): boolean {
  const measuredRepo = process.env.MEASURED_MODEL_HF?.trim();
  if (measuredRepo && entry.hfRepoId && measuredRepo !== entry.hfRepoId) {
    return false;
  }
  const ttl = entry.reachable ? OK_TTL_MS : FAIL_TTL_MS;
  return Date.now() - entry.checkedAt < ttl;
}

async function probe(): Promise<LiveSelfHostedModel> {
  const result = await probeVllmEndpoint({
    servedModelId: SERVED_MODEL_NAME,
    timeoutMs: PROBE_TIMEOUT_MS,
  });

  // Slot 0 answers as redrob-s0; older single-slot installs used bare `redrob`.
  // Prefer an explicit match, then any redrob-* alias, then a lone served model.
  const preferred =
    result.servedModel ??
    result.served.find((m) => m.id === SERVED_MODEL_NAME) ??
    result.served.find((m) => /^redrob(-s\d+)?$/.test(m.id)) ??
    (result.served.length === 1 ? result.served[0]! : null);
  const hfRepoId = preferred?.root ?? null;

  return {
    reachable: result.reachable,
    baseUrl: result.baseUrl,
    servedModelName: preferred?.id ?? SERVED_MODEL_NAME,
    hfRepoId,
    label: hfRepoId ? labelForRepo(hfRepoId) : null,
    maxModelLen: preferred?.maxModelLen ?? null,
    error: result.error,
    checkedAt: Date.now(),
  };
}

/**
 * Resolve the live endpoint, from cache unless forced.
 * Never throws: a catalog request must still answer when the GPU host is off.
 */
export async function getLiveSelfHostedModel(opts?: {
  forceRefresh?: boolean;
}): Promise<LiveSelfHostedModel> {
  if (!opts?.forceRefresh && cache && isFresh(cache)) return cache;
  if (inFlight) return inFlight;

  inFlight = probe()
    .catch(
      (error: unknown): LiveSelfHostedModel => ({
        reachable: false,
        baseUrl: '',
        servedModelName: SERVED_MODEL_NAME,
        hfRepoId: null,
        label: null,
        maxModelLen: null,
        error: error instanceof Error ? error.message : 'probe failed',
        checkedAt: Date.now(),
      }),
    )
    .then((entry) => {
      cache = entry;
      inFlight = null;
      return entry;
    });

  return inFlight;
}

/**
 * Rewrite a self-hosted catalog row to the weights the endpoint is serving now.
 *
 * The row records what Deploy planned, and Deploy can swap the model behind the
 * fixed alias in a minute. Without this, a run answered by the new model is
 * labeled, charted and voted on under the old model's name, which is the one
 * mistake in the whole app that no later step can catch.
 *
 * An unreachable endpoint leaves the row alone: the call is about to fail
 * anyway, and inventing a name for a host that is off helps nobody. Anything
 * measured against the old weights is dropped, because throughput and precision
 * described a different model.
 */
export async function syncSelfHostedRef<T extends { label: string; selfHosted?: SelfHostedMeta }>(
  ref: T,
): Promise<T> {
  if (!ref.selfHosted) return ref;
  const live = await getLiveSelfHostedModel();
  if (!live.reachable || !live.hfRepoId) return ref;
  if (live.hfRepoId === ref.selfHosted.hfRepoId) return ref;

  const candidate = candidateForRepo(live.hfRepoId);
  return {
    ...ref,
    label: `Self-hosted: ${labelForRepo(live.hfRepoId)}`,
    selfHosted: {
      ...ref.selfHosted,
      hfRepoId: live.hfRepoId,
      license: candidate?.license ?? ref.selfHosted.license,
      maxModelLen: live.maxModelLen ?? ref.selfHosted.maxModelLen,
      servedModelName: live.servedModelName,
      precision: 'pending',
      measuredTokPerSec: null,
      measuredAt: null,
    },
  };
}

/** One deploy slot's endpoint, as the catalog sees it. */
export interface LiveSelfHostedSlot extends LiveSelfHostedModel {
  slot: number;
}

let slotsCache: { entries: LiveSelfHostedSlot[]; checkedAt: number } | null = null;
let slotsInFlight: Promise<LiveSelfHostedSlot[]> | null = null;

async function probeSlot(endpoint: {
  slot: number;
  servedName: string;
  baseUrl: string;
}): Promise<LiveSelfHostedSlot> {
  try {
    const result = await probeVllmEndpoint({
      servedModelId: endpoint.servedName,
      baseUrl: endpoint.baseUrl,
      // Slots are probed in parallel and the answer is cached for a minute, so a
      // remote GPU host gets more than the 2s a loopback endpoint needs. Timing
      // out here reads as "not deployed", which is the wrong thing to guess.
      timeoutMs: SLOT_PROBE_TIMEOUT_MS,
    });
    // The alias this slot was asked about wins. Falling back to a lone served
    // model would let slot 1 report slot 0's weights on a shared port typo.
    const preferred =
      result.servedModel ?? result.served.find((m) => m.id === endpoint.servedName) ?? null;
    const hfRepoId = preferred?.root ?? null;
    return {
      slot: endpoint.slot,
      reachable: result.reachable && preferred != null,
      baseUrl: endpoint.baseUrl,
      servedModelName: endpoint.servedName,
      hfRepoId,
      label: hfRepoId ? labelForRepo(hfRepoId) : null,
      maxModelLen: preferred?.maxModelLen ?? null,
      error: result.error,
      checkedAt: Date.now(),
    };
  } catch (error) {
    return {
      slot: endpoint.slot,
      reachable: false,
      baseUrl: endpoint.baseUrl,
      servedModelName: endpoint.servedName,
      hfRepoId: null,
      label: null,
      maxModelLen: null,
      error: error instanceof Error ? error.message : 'probe failed',
      checkedAt: Date.now(),
    };
  }
}

/**
 * Probe every deploy slot and return the ones that answered.
 *
 * A slot that is not serving fails its probe and is dropped, so the list is
 * exactly what is callable right now. Cached like the single-endpoint probe,
 * because the picker asks on every keystroke.
 */
export async function getLiveSelfHostedSlots(opts?: {
  forceRefresh?: boolean;
}): Promise<LiveSelfHostedSlot[]> {
  if (!opts?.forceRefresh && slotsCache) {
    const anyReachable = slotsCache.entries.some((e) => e.reachable);
    const ttl = anyReachable ? OK_TTL_MS : FAIL_TTL_MS;
    if (Date.now() - slotsCache.checkedAt < ttl) return slotsCache.entries;
  }
  if (slotsInFlight) return slotsInFlight;

  const endpoints = vllmSlotEndpoints();
  slotsInFlight = Promise.all(endpoints.map(probeSlot))
    .then((all) => all.filter((e) => e.reachable && e.hfRepoId))
    .catch((): LiveSelfHostedSlot[] => [])
    .then((entries) => {
      slotsCache = { entries, checkedAt: Date.now() };
      slotsInFlight = null;
      return entries;
    });
  return slotsInFlight;
}

/** Test hook: drop the memo so the next call re-probes. */
export function resetLiveSelfHostedCache(): void {
  cache = null;
  inFlight = null;
  slotsCache = null;
  slotsInFlight = null;
}
