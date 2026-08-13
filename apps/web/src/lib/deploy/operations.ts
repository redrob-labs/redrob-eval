import { appendFile, access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  SELF_HOSTED_CANDIDATES,
  SELF_HOSTED_DEFAULTS,
  applyMeasuredThroughput,
  probeVllmEndpoint,
  resetLiveSelfHostedCache,
  resetMeasuredThroughputApplied,
} from '@redrob/harness';
import { ensureVllmApiKey } from '@/lib/settings/env-store';
import {
  removeDeploySlotHost,
  upsertDeploySlotHost,
} from '@/lib/settings/vllm-hosts';
import { sshWriteFile, shellQuote } from './ssh';
import { ensureTerminal, writeTerminal, terminalExists } from './sessions';
import {
  RUNNING_MARKER,
  benchmarkScript,
  healthAllScript,
  healthScript,
  installScript,
  purgeAllScript,
  serviceControl,
  undeployScript,
} from './remote';
import { measureAllScript, measureScript, type MeasureAllStep } from './remote-measure';
import { deployPort } from './port';
import { classifyReachFailure, type SlotReachKind } from './reachability';
import {
  MAX_DEPLOY_SLOTS,
  allSlotIndexes,
  removeSlotRecord,
  resolveSlotIndex,
  slotFor,
  upsertSlot,
  type DeploySlot,
} from './slots';

/** Short: this runs inside the status poll, once per active slot, in parallel. */
const SLOT_REACH_TIMEOUT_MS = 4_000;

export type DeployOp =
  | 'install'
  | 'measure'
  /** Measure and serve every configured slot in one run. */
  | 'measure-all'
  | 'start'
  | 'stop'
  | 'health'
  /** Check every serving slot, in parallel. */
  | 'health-all'
  | 'benchmark'
  | 'undeploy'
  /** Every slot at once, weights included. */
  | 'purge';

/** Ops that act on the whole host rather than on the slot they were given. */
export const WHOLE_HOST_OPS = new Set<DeployOp>([
  'install',
  'purge',
  'measure-all',
  'health-all',
]);

type CandidateKey = keyof typeof SELF_HOSTED_CANDIDATES;

/** The model one Deploy slot serves. */
export interface ServeConfig {
  model: string;
  servedName: string;
  maxModelLen: number;
  maxNumSeqs: number;
  slot: DeploySlot;
}

/**
 * Resolve the model to serve. Preference order:
 *   1. Explicit hf (from a pasted Hugging Face link)
 *   2. Catalog key
 *   3. The catalog default
 * Served name always comes from the slot (`redrob-s{n}`).
 */
export function resolveServeConfig(
  params: { modelKey?: string; hf?: string; slot?: number } = {},
): ServeConfig {
  const key = ((params.modelKey as CandidateKey) in SELF_HOSTED_CANDIDATES
    ? (params.modelKey as CandidateKey)
    : (SELF_HOSTED_DEFAULTS.model as CandidateKey));
  const slot = slotFor(resolveSlotIndex(params.slot ?? 0));
  return {
    model: params.hf?.trim() || SELF_HOSTED_CANDIDATES[key].hfRepoId,
    servedName: slot.servedName,
    maxModelLen: SELF_HOSTED_DEFAULTS.maxModelLen,
    maxNumSeqs: 8,
    slot,
  };
}

export interface OpParams {
  modelKey?: string;
  hf?: string;
  /** Deploy slot index; defaults to 0. */
  slot?: number;
  /** Which slots a whole-host op covers, and the model each one serves. */
  slots?: Array<{ slot: number; modelKey?: string; hf?: string }>;
}

async function secretEnv(): Promise<Record<string, string>> {
  await ensureVllmApiKey();
  const out: Record<string, string> = {};
  if (process.env.VLLM_API_KEY?.trim()) out.VLLM_API_KEY = process.env.VLLM_API_KEY.trim();
  if (process.env.HF_TOKEN?.trim()) out.HF_TOKEN = process.env.HF_TOKEN.trim();
  return out;
}

/** Measure sizes VRAM and writes measured.env; serving is the point of having done so. */
function measureAndServe(cfg: ServeConfig): string {
  return [
    measureScript({ ...cfg, slot: cfg.slot }),
    `echo "==> serving slot ${cfg.slot.index} with the measurement just written"`,
    serviceControl('start', cfg.slot),
  ].join('\n');
}

function buildOpBody(
  op: DeployOp,
  cfg: ServeConfig,
  fleet: ServeConfig[],
): { body: string; sudo: boolean; label: string } {
  const slot = cfg.slot;
  switch (op) {
    case 'install':
      return { body: installScript(), sudo: true, label: 'Install' };
    case 'measure':
      // Measure sizes VRAM and writes measured.env, then the slot is served in
      // the same run: a measured model nobody Started was the whole surprise of
      // the two-button flow. The probe is torn down inside measureScript, so the
      // systemd unit does a clean second load with the util it just recorded.
      return {
        body: measureAndServe(cfg),
        sudo: true,
        label: `Measure & serve (slot ${slot.index})`,
      };
    case 'measure-all':
      return {
        body: measureAllScript(
          fleet.map<MeasureAllStep>((one) => ({
            slot: one.slot,
            model: one.model,
            body: measureAndServe(one),
          })),
        ),
        sudo: true,
        label: `Measure & serve (${fleet.length} slots)`,
      };
    case 'health-all':
      return {
        body: healthAllScript(
          fleet.map((one) => ({ slot: one.slot, servedName: one.servedName })),
        ),
        sudo: false,
        label: `Health (${fleet.length} slots)`,
      };
    case 'start':
    case 'stop':
      return {
        body: serviceControl(op, slot),
        sudo: true,
        label: `${op === 'start' ? 'Start' : 'Stop'} (slot ${slot.index})`,
      };
    case 'undeploy':
      return {
        body: undeployScript(slot),
        sudo: true,
        label: `Undeploy (slot ${slot.index})`,
      };
    case 'purge':
      return { body: purgeAllScript(), sudo: true, label: 'Remove all models' };
    case 'health':
      return {
        body: healthScript(cfg.servedName, 600, slot),
        sudo: false,
        label: `Health (slot ${slot.index})`,
      };
    case 'benchmark':
      // Writes tok/s back into measured.env, so it needs root.
      return {
        body: benchmarkScript(cfg.servedName, 256, slot),
        sudo: true,
        label: `Benchmark (slot ${slot.index})`,
      };
    default:
      throw new Error(`Unknown op: ${op}`);
  }
}

/**
 * Build a full remote script file (secrets exported at the top — never typed
 * into the PTY). Returns the text to write via SFTP.
 */
export async function buildOpScriptFile(
  op: DeployOp,
  params: OpParams = {},
): Promise<{
  content: string;
  sudo: boolean;
  label: string;
  cfg: ServeConfig;
  fleet: ServeConfig[];
}> {
  const cfg = resolveServeConfig(params);
  // A whole-host op with no slot list still has the one it was given to work
  // with, so the button does something sensible rather than nothing.
  const fleet = (params.slots?.length ? params.slots : [{ slot: cfg.slot.index }]).map(
    (one) =>
      resolveServeConfig({
        slot: one.slot,
        modelKey: one.modelKey ?? (one.slot === cfg.slot.index ? params.modelKey : undefined),
        hf: one.hf ?? (one.slot === cfg.slot.index ? params.hf : undefined),
      }),
  );
  const { body, sudo, label } = buildOpBody(op, cfg, fleet);
  const secrets = await secretEnv();
  const exports = Object.entries(secrets)
    .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
    .join('\n');
  const content = [
    '#!/usr/bin/env bash',
    `# redrob-eval deploy op: ${op} slot ${cfg.slot.index}`,
    '# Generated, do not commit. Deleted after run.',
    'set -euo pipefail',
    exports,
    '',
    body,
    '',
  ].join('\n');
  return { content, sudo, label, cfg, fleet };
}

async function syncLocalAfterOp(op: DeployOp, cfg: ServeConfig): Promise<void> {
  const slot = cfg.slot;
  // Measuring every slot registers every slot, so Compare can offer them all.
  if (op === 'measure-all') {
    await syncLocalAfterOp('measure', cfg);
    return;
  }
  if (op === 'measure' || op === 'start') {
    const short = cfg.model.includes('/') ? cfg.model.split('/').pop()! : cfg.model;
    await upsertSlot({
      index: slot.index,
      hf: cfg.model,
      label: `Slot ${slot.index}: ${short}`,
    });
  }
  if (op === 'start' || op === 'measure') {
    const host = process.env.GPU_HOST?.trim();
    if (host) {
      const short = cfg.model.includes('/') ? cfg.model.split('/').pop()! : cfg.model;
      await upsertDeploySlotHost({
        slot: slot.index,
        label: `Slot ${slot.index}: ${short}`,
        baseUrl: `http://${host}:${slot.port}/v1`,
      });
    }
  }
  if (op === 'undeploy') {
    await removeSlotRecord(slot.index);
    await removeDeploySlotHost(slot.index, slot.port);
  }
  if (op === 'purge') {
    for (const index of allSlotIndexes()) {
      await removeSlotRecord(index);
      await removeDeploySlotHost(index, slotFor(index).port);
    }
  }
}

/**
 * Drop the op script on the GPU host via SFTP, then type a run command into
 * the open interactive shell so the user sees live output and can Ctrl+C.
 * Secrets stay in the remote file — not echoed into the PTY.
 */
export async function injectOpIntoTerminal(
  sessionId: string,
  op: DeployOp,
  params: OpParams = {},
): Promise<{
  remotePath: string;
  label: string;
  cfg: ServeConfig;
  fleet: ServeConfig[];
}> {
  // Reconnect rather than fail if the channel dropped — tmux still has the pane.
  if (!terminalExists(sessionId)) {
    await ensureTerminal();
  }
  const { content, sudo, label, cfg, fleet } = await buildOpScriptFile(op, params);
  const remotePath = `/tmp/redrob-op-${op}-${randomUUID().slice(0, 8)}.sh`;
  await sshWriteFile(remotePath, content);
  // chmod +x via the shell so the user sees the run line; secrets not shown
  const rm = sudo ? 'sudo rm -f' : 'rm -f';
  // The marker lets the status poll report this step as in flight, so a
  // reattaching browser sees "running" instead of being offered the button again.
  // Line two is the pid of this shell: if the pane is killed mid-op the marker
  // would otherwise outlive the work and disable every button for good.
  const run =
    `printf '%s\\n%s\\n' ${shellQuote(op)} $$ > ${RUNNING_MARKER}; ` +
    `${sudo ? 'sudo ' : ''}bash ${shellQuote(remotePath)}; ec=$?; ` +
    `${rm} ${shellQuote(remotePath)}; rm -f ${RUNNING_MARKER}; ` +
    `echo \"[redrob] ${label} exit $ec\"`;
  const banner = WHOLE_HOST_OPS.has(op)
    ? `[redrob] ▶ ${label}  ${fleet
        .map((one) => `slot ${one.slot.index}=${one.model}`)
        .join(', ')}`
    : `[redrob] ▶ ${label}  ${cfg.model} as ${cfg.servedName} (slot ${cfg.slot.index}, :${cfg.slot.port})`;
  const typed = [
    '',
    `echo \"${banner}\"`,
    `chmod 700 ${shellQuote(remotePath)}`,
    run,
    '',
  ].join('\n');
  if (!writeTerminal(sessionId, typed)) {
    throw new Error('Failed to write to remote shell');
  }
  for (const one of WHOLE_HOST_OPS.has(op) ? fleet : [cfg]) {
    await syncLocalAfterOp(op, one);
  }
  return { remotePath, label, cfg, fleet };
}

/** Quick helpers the user can also inject (logs / GPU watch). */
export function injectHelperIntoTerminal(
  sessionId: string,
  helper: 'tail' | 'gpu' | 'interrupt',
  slotIndex = 0,
): void {
  if (!terminalExists(sessionId)) {
    throw new Error('Remote shell is not open');
  }
  const slot = slotFor(resolveSlotIndex(slotIndex));
  const cmds: Record<typeof helper, string> = {
    tail: `sudo tail -f ${slot.logFile}\n`,
    gpu: 'watch -n1 nvidia-smi\n',
    interrupt: '\x03', // Ctrl+C
  };
  if (!writeTerminal(sessionId, cmds[helper])) {
    throw new Error('Failed to write to remote shell');
  }
}

/** Parse the remote status script output into a structured object. */
export function parseStatus(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

export interface SlotStatusView {
  index: number;
  port: number;
  unit: string;
  active: boolean;
  enabled: boolean;
  measured: boolean;
  /** Measured, but the slot directory is root-only, so the poll cannot read it. */
  unreadable: boolean;
  modelHf: string | null;
  servedName: string;
  tokPerSec: string | null;
  util: string | null;
  precision: string | null;
  measuredAt: string | null;
  paths: {
    measuredEnv: string;
    serveScript: string;
    logFile: string;
  };
  /** From local registry when present. */
  label: string | null;
  hf: string | null;
  /**
   * Whether the workbench itself can call this port.
   *
   * systemd being active is not enough: the port has to be open to this machine
   * too, and a slot past the base port often is not. Compare can only offer a
   * slot it can reach, so an active-but-unreachable slot has to say so here or
   * it just silently goes missing from the picker.
   */
  reachable: boolean | null;
  reachError: string | null;
  /** Why it could not be called, so the UI names the actual cause. */
  reachKind: SlotReachKind;
}

/** Build per-slot views from the flat SLOT{n}_* status keys + local registry. */
export function buildSlotStatusViews(
  remote: Record<string, string> | null,
  local: Array<{ index: number; hf: string; label: string }>,
): SlotStatusView[] {
  const byIndex = new Map(local.map((r) => [r.index, r]));
  return Array.from({ length: MAX_DEPLOY_SLOTS }, (_, i) => {
    const slot = slotFor(i);
    const prefix = `SLOT${i}_`;
    const get = (k: string) => remote?.[`${prefix}${k}`]?.trim() || null;
    const measured = get('MEASURED') === '1' && Boolean(get('GPU_MEM_UTIL'));
    const localRec = byIndex.get(i);
    return {
      index: i,
      port: Number(get('PORT') || slot.port),
      unit: get('UNIT') || slot.unit,
      active: get('ACTIVE') === 'active',
      enabled: get('ENABLED') === 'enabled' || get('ENABLED') === 'enabled-runtime',
      measured,
      unreadable: get('UNREADABLE') === '1',
      modelHf: get('MODEL_HF') || localRec?.hf || null,
      servedName: get('SERVED_NAME') || get('SERVED_MODEL_NAME') || slot.servedName,
      tokPerSec: get('MEASURED_TOK_PER_SEC'),
      util: get('GPU_MEM_UTIL'),
      precision: get('QUANTIZATION') === 'fp8' ? 'fp8' : get('DTYPE') ? 'bf16' : null,
      measuredAt: get('MEASURED_AT'),
      paths: {
        measuredEnv: get('MEASURED_ENV') || slot.measuredEnv,
        serveScript: get('SERVE_SCRIPT') || slot.serveScript,
        logFile: get('LOG') || slot.logFile,
      },
      label: localRec?.label ?? null,
      hf: localRec?.hf ?? null,
      reachable: null,
      reachError: null,
      reachKind: 'unknown' as SlotReachKind,
    };
  });
}

/**
 * Fill in whether each active slot answers from this machine.
 *
 * Only active slots are probed: a stopped slot not answering is not news, and
 * every probe is a round trip the status poll has to wait for.
 */
export async function attachSlotReachability(
  slots: SlotStatusView[],
  host: string | null,
): Promise<SlotStatusView[]> {
  if (!host) return slots;
  const probes = slots.map(async (slot) => {
    if (!slot.active) return slot;
    const probe = await probeVllmEndpoint({
      baseUrl: `http://${host}:${slot.port}/v1`,
      servedModelId: slot.servedName,
      timeoutMs: SLOT_REACH_TIMEOUT_MS,
    });
    const serving = probe.reachable && probe.servedModels.includes(slot.servedName);
    if (serving) {
      return { ...slot, reachable: true, reachError: null, reachKind: 'ok' as SlotReachKind };
    }
    // Answering at all rules out both the firewall and a service that is not up.
    if (probe.reachable) {
      return {
        ...slot,
        reachable: false,
        reachError: `Answered, but does not serve ${slot.servedName}`,
        reachKind: 'wrongModel' as SlotReachKind,
      };
    }
    return {
      ...slot,
      reachable: false,
      reachError: probe.error ?? 'No answer',
      reachKind: classifyReachFailure(probe.error),
    };
  });
  return Promise.all(probes);
}

/**
 * Pick which measured slot to mirror into process.env for Eval relative cost.
 * Prefer MEASURED_MODEL_HF match, else most recently measured, else slot 0.
 */
function pickMeasuredFlat(remote: Record<string, string>): Record<string, string> {
  const preferredHf = process.env.MEASURED_MODEL_HF?.trim();
  type Cand = { flat: Record<string, string>; at: string; index: number };
  const cands: Cand[] = [];
  for (let i = 0; i < MAX_DEPLOY_SLOTS; i++) {
    const prefix = `SLOT${i}_`;
    const at = remote[`${prefix}MEASURED_AT`]?.trim();
    const util = remote[`${prefix}GPU_MEM_UTIL`]?.trim();
    if (!at || !util) continue;
    const flat: Record<string, string> = {
      MEASURED_AT: at,
      MODEL_HF: remote[`${prefix}MODEL_HF`] ?? '',
      MEASURED_TOK_PER_SEC: remote[`${prefix}MEASURED_TOK_PER_SEC`] ?? '',
      QUANTIZATION: remote[`${prefix}QUANTIZATION`] ?? '',
      DTYPE: remote[`${prefix}DTYPE`] ?? '',
      GPU_MEM_UTIL: util,
      MAX_MODEL_LEN: remote[`${prefix}MAX_MODEL_LEN`] ?? '',
      SERVED_MODEL_NAME: remote[`${prefix}SERVED_MODEL_NAME`] ?? '',
      WEIGHT_MIB: remote[`${prefix}WEIGHT_MIB`] ?? '',
      FREE_MIB: remote[`${prefix}FREE_MIB`] ?? '',
      GPU_NAME: remote.GPU_NAME ?? '',
      GPU_TOTAL_MIB: remote.GPU_TOTAL_MIB ?? remote[`${prefix}GPU_TOTAL_MIB`] ?? '',
      _slot: String(i),
    };
    cands.push({ flat, at, index: i });
  }

  if (cands.length === 0) {
    // Fall back to legacy flat keys (slot 0 / pre-multi-slot).
    return remote;
  }

  if (preferredHf) {
    const hit = cands.find((c) => c.flat.MODEL_HF === preferredHf);
    if (hit) return { ...remote, ...hit.flat };
  }
  cands.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.index - b.index));
  return { ...remote, ...cands[0]!.flat };
}

async function findRepoFile(rel: string): Promise<string | null> {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, rel);
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* keep walking up */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Signature of the measurement already mirrored into this process. */
let appliedSignature: string | null = null;

/**
 * Mirror the host's measured.env (read by the status poll) into this process so
 * Eval sees real precision and throughput, and log each distinct measurement to
 * deploy/MEMORY.md. Values only ever come from the GPU host — never guessed.
 */
export async function applyRemoteMeasured(remote: Record<string, string>): Promise<void> {
  const chosen = pickMeasuredFlat(remote);
  const measuredAt = chosen.MEASURED_AT?.trim();
  if (!measuredAt) return;

  const model = chosen.MODEL_HF?.trim();
  const tok = chosen.MEASURED_TOK_PER_SEC?.trim();
  const precision = chosen.QUANTIZATION === 'fp8' ? 'fp8' : 'bf16';
  const slotIdx = chosen._slot?.trim() || '0';
  const port = deployPort() + Number(slotIdx || 0);

  const signature = `${measuredAt} ${model ?? '?'} tok/s ${tok ?? '-'} slot ${slotIdx}`;
  if (appliedSignature === signature) return;
  appliedSignature = signature;

  if (model && model !== process.env.MEASURED_MODEL_HF?.trim()) {
    resetLiveSelfHostedCache();
  }
  process.env.MEASURED_AT = measuredAt;
  process.env.MEASURED_PRECISION = precision;
  if (model) process.env.MEASURED_MODEL_HF = model;
  if (tok) process.env.MEASURED_TOK_PER_SEC = tok;
  else delete process.env.MEASURED_TOK_PER_SEC;
  resetMeasuredThroughputApplied();
  applyMeasuredThroughput();

  const memPath = await findRepoFile(path.join('deploy', 'MEMORY.md'));
  if (!memPath) return;
  const marker = `<!-- measurement: ${signature} -->`;
  try {
    if ((await readFile(memPath, 'utf8')).includes(marker)) return;
  } catch {
    return;
  }
  const block = [
    '',
    `## Measurement ${measuredAt}`,
    marker,
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| GPU name / total MiB | ${chosen.GPU_NAME ?? 'n/a'} / ${chosen.GPU_TOTAL_MIB ?? 'n/a'} |`,
    `| HF repo | ${model ?? 'n/a'} |`,
    `| slot | ${slotIdx} |`,
    `| served as | ${chosen.SERVED_MODEL_NAME ?? 'n/a'} (:${port}) |`,
    `| dtype / quantization | ${chosen.DTYPE ?? 'n/a'} / ${chosen.QUANTIZATION ?? 'none'} |`,
    `| weight MiB | ${chosen.WEIGHT_MIB || 'not in log'} |`,
    `| gpu-memory-utilization | ${chosen.GPU_MEM_UTIL ?? 'n/a'} |`,
    `| max-model-len | ${chosen.MAX_MODEL_LEN ?? 'n/a'} |`,
    `| free MiB after load | ${chosen.FREE_MIB ?? 'n/a'} |`,
    `| tok/s | ${tok ?? 'pending (run Benchmark)'} |`,
    '',
  ].join('\n');
  try {
    await appendFile(memPath, block + '\n', 'utf8');
  } catch {
    /* non-fatal */
  }
}
