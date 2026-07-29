/**
 * Local video / checklist manifests for human-labeled skill clips.
 *
 * Labeled skill footage is not redistributable under the repo's Apache-only
 * vendored-dataset rule. Manifests live under `datasets/video-local/` (gitignored)
 * and point at frame-sets + labels stored outside the repo.
 *
 * The harness never stores or transmits video bytes — only frame paths listed in
 * the manifest are read into memory for the duration of a scoring call.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MetricId } from '../../config/datasets';
import { datasetsDir } from '../paths';
import type { EvalSample, LoadedDataset } from './types';

export const VIDEO_LOCAL_DIRNAME = 'video-local';

export interface VideoLocalAnchor {
  /** e.g. beginner | intermediate | skilled */
  label: string;
  /** Absolute or repo-relative paths to exemplar frame images (not video). */
  framePaths: string[];
}

export interface VideoLocalExample {
  id: string;
  /**
   * Paths to pre-extracted frame images for this clip.
   * Prefer frame directories — do not put raw video paths here for persisted eval.
   */
  framePaths: string[];
  /**
   * Human reference label: ordinal total, or checklist JSON
   * `{"items":[0,1,...],"total":N}`.
   */
  label: string;
  /** Optional free-text description of the clip context (not scored). */
  context?: string;
}

export interface VideoLocalManifest {
  /** Schema version for the local convention */
  schemaVersion: 1;
  id: string;
  label: string;
  metric?: MetricId;
  /** Fixed few-shot anchors — not optimizable away */
  anchors?: VideoLocalAnchor[];
  examples: VideoLocalExample[];
  notes?: string;
}

export function videoLocalDir(repoDatasetsDir?: string): string {
  return path.join(repoDatasetsDir ?? datasetsDir(), VIDEO_LOCAL_DIRNAME);
}

export function videoLocalManifestPath(manifestId: string, repoDatasetsDir?: string): string {
  const safe = manifestId.replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safe || safe !== manifestId) {
    throw new Error(`Invalid video-local manifest id: ${manifestId}`);
  }
  return path.join(videoLocalDir(repoDatasetsDir), `${safe}.json`);
}

export async function loadVideoLocalManifest(
  manifestId: string,
  options?: { datasetsRoot?: string },
): Promise<VideoLocalManifest> {
  const file = videoLocalManifestPath(manifestId, options?.datasetsRoot);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    throw new Error(
      `Missing video-local manifest at ${file}. ` +
        `Create datasets/video-local/${manifestId}.json pointing at outside-repo frame-sets + labels.`,
    );
  }
  const parsed = JSON.parse(raw) as VideoLocalManifest;
  if (parsed.schemaVersion !== 1) {
    throw new Error(`Unsupported video-local schemaVersion: ${String(parsed.schemaVersion)}`);
  }
  if (!parsed.id || !Array.isArray(parsed.examples) || parsed.examples.length === 0) {
    throw new Error('video-local manifest needs id and a non-empty examples array');
  }
  for (const ex of parsed.examples) {
    if (!ex.id || !Array.isArray(ex.framePaths) || ex.framePaths.length === 0) {
      throw new Error(`Example ${ex.id ?? '?'} needs id and non-empty framePaths`);
    }
    if (typeof ex.label !== 'string') {
      throw new Error(`Example ${ex.id} needs a string label`);
    }
  }
  return parsed;
}

/**
 * Convert a local manifest into a LoadedDataset for GEPA.
 * `input` encodes the frame-set reference as JSON (paths only — never video bytes).
 * Runtime scoring loads those frames into memory and discards them after the call.
 */
export function videoLocalToLoadedDataset(manifest: VideoLocalManifest): LoadedDataset {
  const metric: MetricId = manifest.metric ?? 'qwk';
  const samples: EvalSample[] = manifest.examples.map((ex) => ({
    id: ex.id,
    input: JSON.stringify({
      kind: 'video_frames',
      framePaths: ex.framePaths,
      context: ex.context ?? '',
    }),
    gold: ex.label,
    meta: {
      frameCount: ex.framePaths.length,
      // paths only — never video
    },
  }));

  return {
    datasetId: `video-local:${manifest.id}`,
    label: manifest.label || manifest.id,
    task: 'checklist',
    metric,
    hfDataset: `local/video-local/${manifest.id}`,
    hfConfig: 'default',
    hfSplit: 'all',
    seed: 42,
    maxSamples: samples.length,
    fromCache: true,
    samples,
    license: 'local-non-redistributable',
    vendoredPath: undefined,
  };
}
