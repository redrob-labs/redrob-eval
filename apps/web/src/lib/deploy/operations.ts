import { appendFile, access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  SELF_HOSTED_CANDIDATES,
  SELF_HOSTED_DEFAULTS,
  applyMeasuredThroughput,
  resetMeasuredThroughputApplied,
} from '@redrob/harness';
import { ensureVllmApiKey } from '@/lib/settings/env-store';
import { sshWriteFile, shellQuote } from './ssh';
import { ensureTerminal, writeTerminal, terminalExists } from './sessions';
import {
  RUNNING_MARKER,
  benchmarkScript,
  healthScript,
  installScript,
  serviceControl,
} from './remote';
import { measureScript } from './remote-measure';

export type DeployOp =
  | 'install'
  | 'measure'
  | 'start'
  | 'stop'
  | 'health'
  | 'benchmark';

type CandidateKey = keyof typeof SELF_HOSTED_CANDIDATES;

export interface ServeConfig {
  modelS: string;
  modelL: string;
  servedS: string;
  servedL: string;
  maxModelLen: number;
  maxNumSeqs: number;
}

/**
 * Resolve S/L HF repos. Preference order per axis:
 *   1. Explicit hfS / hfL (from a pasted Hugging Face link)
 *   2. Catalog key (axisS / axisL)
 *   3. Catalog defaults
 */
export function resolveServeConfig(params: {
  axisSKey?: string;
  axisLKey?: string;
  hfS?: string;
  hfL?: string;
} = {}): ServeConfig {
  const sKey = ((params.axisSKey as CandidateKey) in SELF_HOSTED_CANDIDATES
    ? (params.axisSKey as CandidateKey)
    : (SELF_HOSTED_DEFAULTS.axisS as CandidateKey));
  const lKey = ((params.axisLKey as CandidateKey) in SELF_HOSTED_CANDIDATES
    ? (params.axisLKey as CandidateKey)
    : (SELF_HOSTED_DEFAULTS.axisL as CandidateKey));
  const s = SELF_HOSTED_CANDIDATES[sKey];
  const l = SELF_HOSTED_CANDIDATES[lKey];
  const modelS = params.hfS?.trim() || s.hfRepoId;
  const modelL = params.hfL?.trim() || l.hfRepoId;
  return {
    modelS,
    modelL,
    servedS: 'redrob-s',
    servedL: 'redrob-l',
    maxModelLen: SELF_HOSTED_DEFAULTS.maxModelLen,
    maxNumSeqs: 8,
  };
}

async function secretEnv(): Promise<Record<string, string>> {
  await ensureVllmApiKey();
  const out: Record<string, string> = {};
  if (process.env.VLLM_API_KEY?.trim()) out.VLLM_API_KEY = process.env.VLLM_API_KEY.trim();
  if (process.env.HF_TOKEN?.trim()) out.HF_TOKEN = process.env.HF_TOKEN.trim();
  return out;
}

function buildOpBody(
  op: DeployOp,
  cfg: ServeConfig,
): { body: string; sudo: boolean; label: string } {
  switch (op) {
    case 'install':
      return { body: installScript(), sudo: true, label: 'Install' };
    case 'measure':
      return { body: measureScript(cfg), sudo: true, label: 'Measure' };
    case 'start':
    case 'stop':
      return { body: serviceControl(op), sudo: true, label: op === 'start' ? 'Start' : 'Stop' };
    case 'health':
      return { body: healthScript(cfg.servedS, cfg.servedL), sudo: false, label: 'Health' };
    case 'benchmark':
      // Writes tok/s back into measured.env, so it needs root.
      return { body: benchmarkScript(cfg.servedS, cfg.servedL), sudo: true, label: 'Benchmark' };
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
  params: { axisSKey?: string; axisLKey?: string; hfS?: string; hfL?: string } = {},
): Promise<{ content: string; sudo: boolean; label: string; cfg: ServeConfig }> {
  const cfg = resolveServeConfig(params);
  const { body, sudo, label } = buildOpBody(op, cfg);
  const secrets = await secretEnv();
  const exports = Object.entries(secrets)
    .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
    .join('\n');
  const content = [
    '#!/usr/bin/env bash',
    `# redrob-eval deploy op: ${op}`,
    '# Generated — do not commit. Deleted after run.',
    'set -euo pipefail',
    exports,
    '',
    body,
    '',
  ].join('\n');
  return { content, sudo, label, cfg };
}

/**
 * Drop the op script on the GPU host via SFTP, then type a run command into
 * the open interactive shell so the user sees live output and can Ctrl+C.
 * Secrets stay in the remote file — not echoed into the PTY.
 */
export async function injectOpIntoTerminal(
  sessionId: string,
  op: DeployOp,
  params: { axisSKey?: string; axisLKey?: string; hfS?: string; hfL?: string } = {},
): Promise<{ remotePath: string; label: string; cfg: ServeConfig }> {
  // Reconnect rather than fail if the channel dropped — tmux still has the pane.
  if (!terminalExists(sessionId)) {
    await ensureTerminal();
  }
  const { content, sudo, label, cfg } = await buildOpScriptFile(op, params);
  const remotePath = `/tmp/redrob-op-${op}-${randomUUID().slice(0, 8)}.sh`;
  await sshWriteFile(remotePath, content);
  // chmod +x via the shell so the user sees the run line; secrets not shown
  const rm = sudo ? 'sudo rm -f' : 'rm -f';
  // The marker lets the status poll report this step as in flight, so a
  // reattaching browser sees "running" instead of being offered the button again.
  const run =
    `echo ${shellQuote(op)} > ${RUNNING_MARKER}; ` +
    `${sudo ? 'sudo ' : ''}bash ${shellQuote(remotePath)}; ec=$?; ` +
    `${rm} ${shellQuote(remotePath)}; rm -f ${RUNNING_MARKER}; ` +
    `echo \"[redrob] ${label} exit $ec\"`;
  const typed = [
    '',
    `echo \"[redrob] ▶ ${label}  :8101=${cfg.modelS}  :8102=${cfg.modelL}\"`,
    `chmod 700 ${shellQuote(remotePath)}`,
    run,
    '',
  ].join('\n');
  if (!writeTerminal(sessionId, typed)) {
    throw new Error('Failed to write to remote shell');
  }
  return { remotePath, label, cfg };
}

/** Quick helpers the user can also inject (logs / GPU watch). */
export function injectHelperIntoTerminal(
  sessionId: string,
  helper: 'tail-s' | 'tail-l' | 'gpu' | 'interrupt',
): void {
  if (!terminalExists(sessionId)) {
    throw new Error('Remote shell is not open');
  }
  const cmds: Record<typeof helper, string> = {
    'tail-s': 'sudo tail -f /var/log/redrob-vllm/s.log\n',
    'tail-l': 'sudo tail -f /var/log/redrob-vllm/l.log\n',
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
  const measuredAt = remote.MEASURED_AT?.trim();
  if (!measuredAt) return;

  const tokS = remote.MEASURED_TOK_PER_SEC_S?.trim();
  const tokL = remote.MEASURED_TOK_PER_SEC_L?.trim();
  const precisionL = remote.QUANTIZATION_L === 'fp8' ? 'fp8' : 'bf16';

  const signature = `${measuredAt} tok/s ${tokS ?? '-'}/${tokL ?? '-'}`;
  if (appliedSignature === signature) return;
  appliedSignature = signature;

  process.env.MEASURED_AT = measuredAt;
  process.env.MEASURED_PRECISION_L = precisionL;
  process.env.MEASURED_PRECISION_S = 'bf16';
  if (tokS) process.env.MEASURED_TOK_PER_SEC_S = tokS;
  if (tokL) process.env.MEASURED_TOK_PER_SEC_L = tokL;
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
    `| GPU name / total MiB | ${remote.GPU_NAME ?? 'n/a'} / ${remote.GPU_TOTAL_MIB ?? 'n/a'} |`,
    `| :8101 HF repo | ${remote.MODEL_HF_S ?? 'n/a'} |`,
    `| :8102 HF repo | ${remote.MODEL_HF_L ?? 'n/a'} |`,
    `| dtype :8101 / :8102 | ${remote.DTYPE_S ?? 'n/a'} / ${remote.DTYPE_L ?? 'n/a'} |`,
    `| quantization :8102 | ${remote.QUANTIZATION_L ?? 'none'} |`,
    `| weight MiB :8101 / :8102 | ${remote.S_WEIGHT_MIB ?? 'n/a'} / ${remote.L_WEIGHT_MIB ?? 'n/a'} |`,
    `| gpu-memory-utilization :8101 / :8102 | ${remote.GPU_MEM_UTIL_S ?? 'n/a'} / ${remote.GPU_MEM_UTIL_L ?? 'n/a'} |`,
    `| max-model-len :8101 / :8102 | ${remote.MAX_MODEL_LEN_S ?? 'n/a'} / ${remote.MAX_MODEL_LEN_L ?? 'n/a'} |`,
    `| dual-load free MiB | ${remote.DUAL_FREE_MIB ?? 'n/a'} |`,
    `| tok/s :8101 / :8102 | ${tokS ?? 'pending (run Benchmark)'} / ${tokL ?? 'pending (run Benchmark)'} |`,
    '',
  ].join('\n');
  try {
    await appendFile(memPath, block + '\n', 'utf8');
  } catch {
    /* non-fatal */
  }
}
