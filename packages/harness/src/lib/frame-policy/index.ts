/**
 * Frame sampling gene for video / checklist scoring.
 * Same first-class treatment as script_policy — GEPA searches over it.
 *
 * Frames held in memory for a single scoring call only; never persist video bytes.
 */

export type FrameSampleStrategy = 'uniform' | 'motion_energy' | 'event_detect';

export type FrameCount = 4 | 8 | 16;
export type TokensPerFrame = 256 | 640 | 1280;

export const FRAME_SAMPLE_STRATEGIES: FrameSampleStrategy[] = [
  'uniform',
  'motion_energy',
  'event_detect',
];

export const FRAME_COUNTS: FrameCount[] = [4, 8, 16];
export const TOKENS_PER_FRAME: TokensPerFrame[] = [256, 640, 1280];

export interface FramePolicy {
  strategy: FrameSampleStrategy;
  n_frames: FrameCount;
  tokens_per_frame: TokensPerFrame;
}

export function defaultFramePolicy(
  partial?: Partial<FramePolicy>,
): FramePolicy {
  return {
    strategy: partial?.strategy ?? 'uniform',
    n_frames: partial?.n_frames ?? 8,
    tokens_per_frame: partial?.tokens_per_frame ?? 640,
  };
}

export function parseFramePolicy(v: unknown): FramePolicy | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const rec = v as Record<string, unknown>;
  const strategy =
    typeof rec.strategy === 'string' &&
    (FRAME_SAMPLE_STRATEGIES as string[]).includes(rec.strategy)
      ? (rec.strategy as FrameSampleStrategy)
      : null;
  const nRaw = rec.n_frames;
  const n_frames =
    typeof nRaw === 'number' && (FRAME_COUNTS as number[]).includes(nRaw)
      ? (nRaw as FrameCount)
      : null;
  const tRaw = rec.tokens_per_frame;
  const tokens_per_frame =
    typeof tRaw === 'number' && (TOKENS_PER_FRAME as number[]).includes(tRaw)
      ? (tRaw as TokensPerFrame)
      : null;
  if (!strategy || !n_frames || !tokens_per_frame) return null;
  return { strategy, n_frames, tokens_per_frame };
}

/**
 * Map tokens_per_frame → Qwen-VL-family min_pixels / max_pixels.
 * Rough rule: ~28² patch tokens; callers pass through provider vision controls.
 */
export function tokensPerFrameToPixels(tokens: TokensPerFrame): {
  min_pixels: number;
  max_pixels: number;
} {
  const patch = 28 * 28;
  return {
    min_pixels: Math.max(patch, Math.floor(tokens * patch * 0.25)),
    max_pixels: tokens * patch,
  };
}

/** In-memory frame for sampling (never written to disk by the harness). */
export interface FrameBuffer {
  /** Index in the source clip (0-based). */
  index: number;
  /**
   * Optional dense luma (or mean-channel) values for motion_energy / event_detect.
   * Length may be a downsampled grid; only relative magnitudes matter.
   */
  luma?: Float32Array | number[];
}

export interface FitFramesResult {
  framesRequested: number;
  framesFitted: number;
  /** Selected frame indices (source order). */
  indices: number[];
  tokensPerFrame: TokensPerFrame;
  strategy: FrameSampleStrategy;
  vision: { min_pixels: number; max_pixels: number };
}

function clampCount(n: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(1, Math.min(n, total));
}

/** Evenly spaced indices across [0, total). */
export function sampleUniform(total: number, n: number): number[] {
  const k = clampCount(n, total);
  if (k === 0) return [];
  if (k === 1) return [Math.floor(total / 2)];
  const out: number[] = [];
  for (let i = 0; i < k; i++) {
    out.push(Math.round((i * (total - 1)) / (k - 1)));
  }
  return dedupeSorted(out);
}

function frameDiffEnergy(a: Float32Array | number[], b: Float32Array | number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    sum += d * d;
  }
  return sum / n;
}

/** Motion energy between consecutive frames that have luma buffers. */
export function computeMotionEnergy(frames: FrameBuffer[]): number[] {
  const energy = new Array(frames.length).fill(0);
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1]!;
    const cur = frames[i]!;
    if (prev.luma && cur.luma) {
      energy[i] = frameDiffEnergy(prev.luma, cur.luma);
    } else {
      // No pixel data: mild bias toward later frames so strategy still varies indices.
      energy[i] = i / frames.length;
    }
  }
  return energy;
}

/**
 * Sample where frame-to-frame pixel difference is highest.
 * Always includes endpoints lightly via top-k over motion peaks.
 */
export function sampleMotionEnergy(frames: FrameBuffer[], n: number): number[] {
  const total = frames.length;
  const k = clampCount(n, total);
  if (k === 0) return [];
  if (k >= total) return frames.map((f) => f.index);

  const energy = computeMotionEnergy(frames);
  const ranked = energy
    .map((e, i) => ({ i, e }))
    .sort((a, b) => b.e - a.e || a.i - b.i);
  const picked = new Set<number>();
  for (const row of ranked) {
    if (picked.size >= k) break;
    picked.add(frames[row.i]!.index);
  }
  // Ensure at least one early + late frame when room remains
  if (picked.size < k) picked.add(frames[0]!.index);
  if (picked.size < k) picked.add(frames[total - 1]!.index);
  return [...picked].sort((a, b) => a - b).slice(0, k);
}

/**
 * Event-detect: optional classifier scores per frame; falls back to motion peaks.
 * `eventScores` length must match `frames` when provided (higher = more event-like).
 */
export function sampleEventDetect(
  frames: FrameBuffer[],
  n: number,
  eventScores?: number[],
): number[] {
  if (!eventScores || eventScores.length !== frames.length) {
    return sampleMotionEnergy(frames, n);
  }
  const total = frames.length;
  const k = clampCount(n, total);
  if (k === 0) return [];
  if (k >= total) return frames.map((f) => f.index);

  const ranked = eventScores
    .map((score, i) => ({ i, score }))
    .sort((a, b) => b.score - a.score || a.i - b.i);
  const picked = new Set<number>();
  for (const row of ranked) {
    if (picked.size >= k) break;
    picked.add(frames[row.i]!.index);
  }
  return [...picked].sort((a, b) => a - b);
}

function dedupeSorted(indices: number[]): number[] {
  const out: number[] = [];
  for (const i of indices) {
    if (out.length === 0 || out[out.length - 1] !== i) out.push(i);
  }
  return out;
}

export function sampleFrames(
  policy: FramePolicy,
  frames: FrameBuffer[],
  eventScores?: number[],
): number[] {
  switch (policy.strategy) {
    case 'uniform':
      return sampleUniform(frames.length, policy.n_frames);
    case 'motion_energy':
      return sampleMotionEnergy(frames, policy.n_frames);
    case 'event_detect':
      return sampleEventDetect(frames, policy.n_frames, eventScores);
    default: {
      const _e: never = policy.strategy;
      return _e;
    }
  }
}

/**
 * Fit frames into a visual-token budget: frames_requested vs frames_fitted.
 * When `maxVisualTokens` is set, greedily drop the least-central frames.
 */
export function fitFramesToBudget(params: {
  policy: FramePolicy;
  frames: FrameBuffer[];
  /** Soft budget ≈ n_frames * tokens_per_frame; override for tighter caps */
  maxVisualTokens?: number | null;
  eventScores?: number[];
}): FitFramesResult {
  const policy = defaultFramePolicy(params.policy);
  const requested = policy.n_frames;
  const vision = tokensPerFrameToPixels(policy.tokens_per_frame);
  if (params.frames.length === 0) {
    return {
      framesRequested: requested,
      framesFitted: 0,
      indices: [],
      tokensPerFrame: policy.tokens_per_frame,
      strategy: policy.strategy,
      vision,
    };
  }

  let indices = sampleFrames(policy, params.frames, params.eventScores);
  const budget =
    params.maxVisualTokens == null || params.maxVisualTokens <= 0
      ? null
      : params.maxVisualTokens;

  if (budget != null) {
    const maxFrames = Math.max(1, Math.floor(budget / policy.tokens_per_frame));
    while (indices.length > maxFrames) {
      // Drop the middle-most oddly positioned index to keep span
      const mid = Math.floor(indices.length / 2);
      indices = [...indices.slice(0, mid), ...indices.slice(mid + 1)];
    }
  }

  return {
    framesRequested: requested,
    framesFitted: indices.length,
    indices,
    tokensPerFrame: policy.tokens_per_frame,
    strategy: policy.strategy,
    vision,
  };
}
