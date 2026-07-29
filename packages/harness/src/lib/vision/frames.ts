/**
 * Ephemeral frame I/O for checklist scoring.
 * Bytes stay in memory for one scoring call only — never written to logs/datasets/exports.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FrameBuffer } from '../frame-policy';
import type { VisionImagePart } from '../providers/types';

function mimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

export interface FrameSetRef {
  kind: 'video_frames';
  framePaths: string[];
  context?: string;
}

export function parseFrameSetInput(input: string): FrameSetRef | null {
  const t = input.trim();
  if (!t.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(t) as Record<string, unknown>;
    if (parsed.kind !== 'video_frames') return null;
    if (!Array.isArray(parsed.framePaths)) return null;
    const framePaths = parsed.framePaths.filter((p): p is string => typeof p === 'string');
    if (framePaths.length === 0) return null;
    return {
      kind: 'video_frames',
      framePaths,
      context: typeof parsed.context === 'string' ? parsed.context : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Build lightweight FrameBuffer stubs (index only) for sampling strategies
 * that do not need luma. motion_energy falls back when luma is absent.
 */
export function frameBuffersFromPaths(framePaths: string[]): FrameBuffer[] {
  return framePaths.map((_, index) => ({ index }));
}

/**
 * Optional coarse luma from raw bytes (every Nth byte) for motion_energy —
 * not a decode; just a cheap fingerprint so strategy differs from uniform offline.
 */
export function coarseLumaFromBytes(bytes: Uint8Array, samples = 64): Float32Array {
  const out = new Float32Array(samples);
  if (bytes.length === 0) return out;
  const step = Math.max(1, Math.floor(bytes.length / samples));
  for (let i = 0; i < samples; i++) {
    out[i] = bytes[Math.min(bytes.length - 1, i * step)]! / 255;
  }
  return out;
}

/**
 * Load selected frame paths into VisionImagePart[] for one model call.
 * Caller must drop the returned array when the call completes (GC).
 * Does not accept or persist video containers — image frames only.
 */
export async function loadFrameImages(
  framePaths: string[],
  indices: number[],
): Promise<{ images: VisionImagePart[]; buffers: FrameBuffer[] }> {
  const images: VisionImagePart[] = [];
  const buffers: FrameBuffer[] = [];
  for (const idx of indices) {
    const filePath = framePaths[idx];
    if (!filePath) continue;
    const bytes = await fs.readFile(filePath);
    const luma = coarseLumaFromBytes(bytes);
    buffers.push({ index: idx, luma });
    images.push({
      mimeType: mimeFromPath(filePath),
      base64: Buffer.from(bytes).toString('base64'),
    });
  }
  return { images, buffers };
}
