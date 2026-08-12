/**
 * Self-hosted (vLLM) catalog metadata.
 *
 * There is one endpoint. Deploy serves a single model on it, so the catalog
 * below is a list of candidates for that one slot, not a set of endpoints.
 *
 * Relative cost formula (also in deploy/README.md and results.ts):
 *   relativeCostWeight(m) = 100 * (tok_per_sec_large / tok_per_sec_m)
 * Large-alone throughput defines the 100 baseline (GPU-time per token).
 * Do not hardcode absolute $/hour. Weights below stay at that definition until
 * the Benchmark step on /deploy measures tok/s.
 */

/**
 * `--served-model-name` for the endpoint, whatever model is behind it. Eval ids
 * stay put when you swap the model, which is the point of having it fixed.
 */
export const SERVED_MODEL_NAME = 'redrob';

/** Rough size class. Groups the deploy picker and sets the eval tier. */
export type SelfHostedTier = 'small' | 'large';

export type SelfHostedPrecision = 'bf16' | 'fp8' | 'mxfp4' | 'pending';

/**
 * `lfm1.0` is the LFM Open License v1.0: Apache-shaped, but section 5 withdraws
 * the commercial grant from a legal entity at or above $10M annual revenue.
 * Usable here, unlike cc-by-nc, so the threshold rides along in each note.
 */
export type SelfHostedLicense = 'apache-2.0' | 'mit' | 'lfm1.0';

export interface SelfHostedMeta {
  /** Hugging Face repo id verified at catalog time */
  hfRepoId: string;
  /** Exact license string from the model card `license` field */
  license: SelfHostedLicense;
  /** Serving precision; FP8 must be called out in every result caveat */
  precision: SelfHostedPrecision;
  /** vLLM --max-model-len (not the model native 256K) */
  maxModelLen: number;
  /** vLLM --served-model-name (stable Eval id independent of HF path) */
  servedModelName: string;
  /**
   * Measured output tok/s from the Benchmark step on /deploy.
   * null until measured — relative cost must not pretend to be final.
   */
  measuredTokPerSec: number | null;
  /** ISO date of last throughput / memory measurement, if any */
  measuredAt: string | null;
}

/**
 * Env: VLLM_API_KEY required. One endpoint, called directly on the GPU host.
 *
 * The default below is only a last resort for a workbench running on that host.
 * Deploy fills VLLM_BASE_URL in from GPU_HOST, and that is the normal path.
 */
export const VLLM_ENV = {
  apiKey: 'VLLM_API_KEY',
  baseUrl: 'VLLM_BASE_URL',
  /**
   * Explicit `servedName=baseUrl` pairs, comma separated, for hosts where the
   * slots are not consecutive ports behind VLLM_BASE_URL. Normally unset: the
   * ports are derived instead, so deploying a second slot needs no settings edit.
   */
  slotUrls: 'VLLM_SLOT_URLS',
  defaultBaseUrl: 'http://127.0.0.1:8000/v1',
} as const;

/**
 * How many consecutive slot ports to consider when the map is derived rather
 * than declared. Mirrors MAX_DEPLOY_SLOTS on the Deploy side; a slot that is not
 * serving simply fails its probe, so guessing high only costs probe time.
 */
const DERIVED_SLOT_COUNT = 8;

/** One vLLM endpoint: the alias it answers to and where to reach it. */
export interface VllmSlotEndpoint {
  slot: number;
  /** vLLM `--served-model-name` for this slot, e.g. `redrob-s1`. */
  servedName: string;
  baseUrl: string;
}

/** `redrob-s{n}`, matching what Deploy passes to --served-model-name. */
export function slotServedName(slot: number): string {
  return `${SERVED_MODEL_NAME}-s${slot}`;
}

function parseDeclaredSlots(raw: string): VllmSlotEndpoint[] {
  const out: VllmSlotEndpoint[] = [];
  for (const pair of raw.split(',')) {
    const [name, ...rest] = pair.split('=');
    const servedName = name?.trim();
    const baseUrl = rest.join('=').trim();
    if (!servedName || !baseUrl) continue;
    const slot = Number(/-s(\d+)$/.exec(servedName)?.[1] ?? out.length);
    out.push({ slot: Number.isFinite(slot) ? slot : out.length, servedName, baseUrl });
  }
  return out;
}

/**
 * Every endpoint that might be serving a deploy slot.
 *
 * Deploy puts slot n on `VLLM_PORT + n` and names it `redrob-s{n}`, so the whole
 * set follows from the one base URL already in the settings. Without this the
 * catalog only ever knew about the base port, and a second deployed model was
 * invisible no matter how healthy it was.
 */
export function vllmSlotEndpoints(env: NodeJS.ProcessEnv = process.env): VllmSlotEndpoint[] {
  const declared = env[VLLM_ENV.slotUrls]?.trim();
  if (declared) {
    const parsed = parseDeclaredSlots(declared);
    if (parsed.length > 0) return parsed;
  }

  const base = env[VLLM_ENV.baseUrl]?.trim() || VLLM_ENV.defaultBaseUrl;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return [];
  }
  const basePort = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!Number.isFinite(basePort)) return [];

  const out: VllmSlotEndpoint[] = [];
  for (let slot = 0; slot < DERIVED_SLOT_COUNT; slot += 1) {
    const slotUrl = new URL(base);
    slotUrl.port = String(basePort + slot);
    out.push({
      slot,
      servedName: slotServedName(slot),
      baseUrl: slotUrl.toString().replace(/\/+$/, ''),
    });
  }
  return out;
}

/** Base URL for one served alias, or null when it is not a known slot name. */
export function baseUrlForServedName(
  servedName: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const hit = vllmSlotEndpoints(env).find((s) => s.servedName === servedName);
  return hit?.baseUrl ?? null;
}

/**
 * Candidates verified on Hugging Face (license field read from card).
 * Exclusions documented — do not add unverified ids.
 */
export const SELF_HOSTED_CANDIDATES = {
  /** What Deploy offers first */
  'gemma4-e4b': {
    id: 'vllm-gemma4-e4b',
    label: 'Gemma 4 E4B (self-hosted)',
    hfRepoId: 'google/gemma-4-E4B-it',
    license: 'apache-2.0' as const,
    tier: 'small' as const,
    notes: 'Default small; Office/Floor local-inference candidate.',
  },
  'gemma4-31b': {
    id: 'vllm-gemma4-31b',
    label: 'Gemma 4 31B (self-hosted)',
    hfRepoId: 'google/gemma-4-31B-it',
    license: 'apache-2.0' as const,
    tier: 'large' as const,
    notes: 'Default large dense on single 96GB card.',
  },
  /** Axis L swap candidate (Indic-focused A/B) */
  'qwen36-27b': {
    id: 'vllm-qwen36-27b',
    label: 'Qwen3.6 27B (self-hosted)',
    hfRepoId: 'Qwen/Qwen3.6-27B',
    license: 'apache-2.0' as const,
    tier: 'large' as const,
    notes: 'Registered L swap for Gemma 4 31B vs Qwen3.6 27B Indic comparison.',
  },
  'gemma4-26b-a4b': {
    id: 'vllm-gemma4-26b-a4b',
    label: 'Gemma 4 26B A4B MoE (self-hosted)',
    hfRepoId: 'google/gemma-4-26B-A4B-it',
    license: 'apache-2.0' as const,
    tier: 'large' as const,
    notes: 'MoE alternate; HF id is A4B (not A3.8B).',
  },
  'qwen36-35b-a3b': {
    id: 'vllm-qwen36-35b-a3b',
    label: 'Qwen3.6 35B-A3B (self-hosted)',
    hfRepoId: 'Qwen/Qwen3.6-35B-A3B',
    license: 'apache-2.0' as const,
    tier: 'large' as const,
    notes: 'MoE alternate L candidate.',
  },
  'gpt-oss-120b': {
    id: 'vllm-gpt-oss-120b',
    label: 'gpt-oss-120b (self-hosted)',
    hfRepoId: 'openai/gpt-oss-120b',
    license: 'apache-2.0' as const,
    tier: 'large' as const,
    notes: 'Large candidate; may not fit 96GB even alone, so measure before serving.',
  },

  /*
   * Tool-routing candidates, so the model Compare picks is the model Deploy can
   * serve. Keys match TOOL_ROUTING_MODELS ids on purpose. All small: none is
   * above 4B. The two cc-by-nc Hammer entries stay out, see the exclusions.
   */
  'qwen3-0.6b': {
    id: 'vllm-qwen3-0.6b',
    label: 'Qwen3 0.6B (self-hosted)',
    hfRepoId: 'Qwen/Qwen3-0.6B',
    license: 'apache-2.0' as const,
    tier: 'small' as const,
    notes: 'Tool-routing candidate; fertility baseline (1.0).',
  },
  'qwen3-1.7b': {
    id: 'vllm-qwen3-1.7b',
    label: 'Qwen3 1.7B (self-hosted)',
    hfRepoId: 'Qwen/Qwen3-1.7B',
    license: 'apache-2.0' as const,
    tier: 'small' as const,
    notes: 'Tool-routing candidate.',
  },
  'qwen3-4b': {
    id: 'vllm-qwen3-4b',
    label: 'Qwen3 4B (self-hosted)',
    hfRepoId: 'Qwen/Qwen3-4B',
    license: 'apache-2.0' as const,
    tier: 'small' as const,
    notes: 'Tool-routing candidate.',
  },
  'qwen35-0.8b': {
    id: 'vllm-qwen35-0.8b',
    label: 'Qwen3.5 0.8B (self-hosted)',
    hfRepoId: 'Qwen/Qwen3.5-0.8B',
    license: 'apache-2.0' as const,
    tier: 'small' as const,
    notes: 'Tool-routing candidate.',
  },
  'qwen35-2b': {
    id: 'vllm-qwen35-2b',
    label: 'Qwen3.5 2B (self-hosted)',
    hfRepoId: 'Qwen/Qwen3.5-2B',
    license: 'apache-2.0' as const,
    tier: 'small' as const,
    notes: 'Tool-routing candidate.',
  },
  'qwen35-4b': {
    id: 'vllm-qwen35-4b',
    label: 'Qwen3.5 4B (self-hosted)',
    hfRepoId: 'Qwen/Qwen3.5-4B',
    license: 'apache-2.0' as const,
    tier: 'small' as const,
    notes: 'Tool-routing candidate.',
  },
  'granite-4.0-1b': {
    id: 'vllm-granite-4.0-1b',
    label: 'Granite 4.0 1B (self-hosted)',
    hfRepoId: 'ibm-granite/granite-4.0-1b',
    license: 'apache-2.0' as const,
    tier: 'small' as const,
    notes: 'Tool-routing candidate.',
  },
  'granite-4.0-350m': {
    id: 'vllm-granite-4.0-350m',
    label: 'Granite 4.0 350M (self-hosted)',
    hfRepoId: 'ibm-granite/granite-4.0-350m',
    license: 'apache-2.0' as const,
    tier: 'small' as const,
    notes: 'Tool-routing candidate.',
  },
  'granite-4.0-h-1b': {
    id: 'vllm-granite-4.0-h-1b',
    label: 'Granite 4.0 H 1B (self-hosted)',
    hfRepoId: 'ibm-granite/granite-4.0-h-1b',
    license: 'apache-2.0' as const,
    tier: 'small' as const,
    notes: 'Tool-routing candidate; hybrid SSM - vLLM may refuse to load it.',
  },
  'granite-4.0-h-350m': {
    id: 'vllm-granite-4.0-h-350m',
    label: 'Granite 4.0 H 350M (self-hosted)',
    hfRepoId: 'ibm-granite/granite-4.0-h-350m',
    license: 'apache-2.0' as const,
    tier: 'small' as const,
    notes: 'Tool-routing candidate; hybrid SSM - vLLM may refuse to load it.',
  },
  'granite-4.0-micro': {
    id: 'vllm-granite-4.0-micro',
    label: 'Granite 4.0 Micro (self-hosted)',
    hfRepoId: 'ibm-granite/granite-4.0-micro',
    license: 'apache-2.0' as const,
    tier: 'small' as const,
    notes: 'Tool-routing candidate.',
  },
  'midm-2.0-mini': {
    id: 'vllm-midm-2.0-mini',
    label: 'Midm 2.0 Mini Instruct (self-hosted)',
    hfRepoId: 'K-intelligence/Midm-2.0-Mini-Instruct',
    license: 'mit' as const,
    tier: 'small' as const,
    notes: 'Tool-routing candidate; Korean-focused.',
  },

  /*
   * LFM2.5 (Liquid AI). Edge-sized, and the only family here that ships a
   * revenue-conditioned license, so every note repeats the threshold. vLLM
   * loads Lfm2ForCausalLM and Lfm2MoeForCausalLM; Install pulls current vLLM,
   * so an older venv on the host has to be reinstalled before serving these.
   */
  'lfm25-230m': {
    id: 'vllm-lfm25-230m',
    label: 'LFM2.5 230M (self-hosted)',
    hfRepoId: 'LiquidAI/LFM2.5-230M',
    license: 'lfm1.0' as const,
    tier: 'small' as const,
    notes: 'Tool-routing candidate; commercial use only below $10M revenue.',
  },
  'lfm25-350m': {
    id: 'vllm-lfm25-350m',
    label: 'LFM2.5 350M (self-hosted)',
    hfRepoId: 'LiquidAI/LFM2.5-350M',
    license: 'lfm1.0' as const,
    tier: 'small' as const,
    notes: 'Tool-routing candidate; commercial use only below $10M revenue.',
  },
  'lfm25-1.2b': {
    id: 'vllm-lfm25-1.2b',
    label: 'LFM2.5 1.2B Instruct (self-hosted)',
    hfRepoId: 'LiquidAI/LFM2.5-1.2B-Instruct',
    license: 'lfm1.0' as const,
    tier: 'small' as const,
    notes: 'Tool-routing candidate; commercial use only below $10M revenue.',
  },
  'lfm25-1.2b-thinking': {
    id: 'vllm-lfm25-1.2b-thinking',
    label: 'LFM2.5 1.2B Thinking (self-hosted)',
    hfRepoId: 'LiquidAI/LFM2.5-1.2B-Thinking',
    license: 'lfm1.0' as const,
    tier: 'small' as const,
    notes:
      'Reasoning variant; emits a thinking block, so raise max tokens. Commercial use only below $10M revenue.',
  },
  'lfm25-2.6b': {
    id: 'vllm-lfm25-2.6b',
    label: 'LFM2.5 2.6B (self-hosted)',
    hfRepoId: 'LiquidAI/LFM2.5-2.6B',
    license: 'lfm1.0' as const,
    tier: 'small' as const,
    notes: 'Largest dense LFM2.5; commercial use only below $10M revenue.',
  },
  'lfm25-8b-a1b': {
    id: 'vllm-lfm25-8b-a1b',
    label: 'LFM2.5 8B A1B MoE (self-hosted)',
    hfRepoId: 'LiquidAI/LFM2.5-8B-A1B',
    license: 'lfm1.0' as const,
    tier: 'small' as const,
    notes:
      'MoE, 8B total and 1B active, so it costs like a small model. Commercial use only below $10M revenue.',
  },
} as const;

/**
 * Excluded after verification attempt:
 * - Qwen3.6 "small": no HF repo in the Qwen3.6 family (only 27B / 35B-A3B).
 * - microsoft/phi-4 (mit): excluded from Eval catalog — training blend includes
 *   synthetic data associated with commercial-API-output distillation risk
 *   (hard constraint: no models trained on commercial API outputs).
 */
export const SELF_HOSTED_EXCLUSIONS = [
  {
    requested: 'Qwen3.6 small',
    reason: 'No Hugging Face repo in Qwen3.6 family at small scale; only 27B and 35B-A3B verified.',
  },
  {
    requested: 'microsoft/phi-4',
    reason:
      'MIT license verified, but excluded under commercial-API-output training ban (synthetic distillation risk).',
  },
  {
    requested: 'MadeAgents/Hammer2.1-0.5b, MadeAgents/Hammer2.1-1.5b',
    reason:
      'Tool-routing candidates, but cc-by-nc-4.0. eval_only never reaches a served endpoint, so they are absent from the deploy catalog by design.',
  },
  {
    requested: 'LFM2.5 GGUF / ONNX / MLX / Base / VL / Audio / Encoder variants',
    reason:
      'Only the safetensors instruct-tuned text checkpoints are listed. The quantized and runtime-specific repos are for other stacks, and Base, VL, Audio and Encoder are the wrong task for a text eval or a tool-routing prompt.',
  },
] as const;

export const SELF_HOSTED_DEFAULTS = {
  /** Offered first on /deploy, and the row the eval catalog starts from. */
  model: 'gemma4-e4b' as const,
  /**
   * Context cap, and with `max_tokens` omitted on vLLM it is also the reply
   * ceiling. A thinking model spends this budget on its trace before it answers,
   * so 8192 left reasoning models cut off mid-trace ("Cut off inside the
   * reasoning trace before any answer"). Doubled to give the trace room while
   * staying far below native 256K, where the KV cache would dominate VRAM and a
   * slot on a shared card could fail to come up.
   */
  maxModelLen: 16384,
};

/**
 * A large model alone = 100.
 * weight(m) = 100 * (tok/s_large / tok/s_m)
 */
export function relativeCostFromThroughput(params: {
  modelTokPerSec: number;
  largeTokPerSec: number;
}): number {
  if (params.modelTokPerSec <= 0 || params.largeTokPerSec <= 0) {
    throw new Error('tok/s must be positive for relative cost');
  }
  return (100 * params.largeTokPerSec) / params.modelTokPerSec;
}

export function resolveSelfHostedCostWeight(params: {
  measuredTokPerSec: number | null;
  largeMeasuredTokPerSec: number | null;
  /** Fallback only when throughput unmeasured — must be flagged in caveat */
  fallbackWeight: number;
}): { weight: number; costSource: 'measured-throughput' | 'unmeasured-fallback' } {
  if (
    params.measuredTokPerSec != null &&
    params.measuredTokPerSec > 0 &&
    params.largeMeasuredTokPerSec != null &&
    params.largeMeasuredTokPerSec > 0
  ) {
    return {
      weight: relativeCostFromThroughput({
        modelTokPerSec: params.measuredTokPerSec,
        largeTokPerSec: params.largeMeasuredTokPerSec,
      }),
      costSource: 'measured-throughput',
    };
  }
  return { weight: params.fallbackWeight, costSource: 'unmeasured-fallback' };
}

export function buildSelfHostedCaveat(meta: SelfHostedMeta, extra?: string[]): string {
  const parts = [
    `precision=${meta.precision}`,
    `license=${meta.license}`,
    `hf=${meta.hfRepoId}`,
    `maxModelLen=${meta.maxModelLen}`,
    meta.measuredAt ? `measuredAt=${meta.measuredAt}` : 'measuredAt=pending',
    meta.measuredTokPerSec != null
      ? `tok/s=${meta.measuredTokPerSec}`
      : 'tok/s=unmeasured (relative cost is fallback until the Benchmark step runs)',
  ];
  if (meta.precision === 'fp8') {
    parts.push('CAVEAT: FP8 quantization, do not compare to bf16 rows without this note');
  }
  if (extra?.length) parts.push(...extra);
  return parts.join('; ');
}
