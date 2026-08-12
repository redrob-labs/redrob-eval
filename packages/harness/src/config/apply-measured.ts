/**
 * Apply measurements taken by /deploy (mirrored from the GPU host) onto the
 * self-hosted row in EVAL_MODELS.
 *
 * Env (optional):
 *   MEASURED_MODEL_HF   Hugging Face repo the endpoint is serving
 *   MEASURED_TOK_PER_SEC
 *   MEASURED_PRECISION  (bf16|fp8|mxfp4|pending)
 *   MEASURED_AT         (ISO date string)
 *
 * Mutates the row in place. Throughput is attributed to the model that was
 * actually benchmarked and nothing else: a 0.6B and a 4B do not share a tok/s
 * just because both are small.
 */

import { EVAL_MODELS, SELF_HOSTED_ENDPOINT_ID } from './models';
import {
  SELF_HOSTED_CANDIDATES,
  relativeCostFromThroughput,
  type SelfHostedPrecision,
} from './self-hosted';

const PRECISION_SET = new Set<SelfHostedPrecision>([
  'bf16',
  'fp8',
  'mxfp4',
  'pending',
]);

function parsePositiveFloat(raw: string | undefined): number | null {
  if (raw == null || !raw.trim()) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function parsePrecision(raw: string | undefined): SelfHostedPrecision | null {
  const v = raw?.trim().toLowerCase();
  if (!v) return null;
  if (PRECISION_SET.has(v as SelfHostedPrecision)) {
    return v as SelfHostedPrecision;
  }
  return null;
}

let applied = false;

/** Idempotent: mutates the self-hosted row from MEASURED_* env. */
export function applyMeasuredThroughput(): typeof EVAL_MODELS {
  if (applied) return EVAL_MODELS;
  applied = true;

  const hfRepoId = process.env.MEASURED_MODEL_HF?.trim() || null;
  const tok = parsePositiveFloat(process.env.MEASURED_TOK_PER_SEC);
  const precision = parsePrecision(process.env.MEASURED_PRECISION);
  const measuredAt = process.env.MEASURED_AT?.trim() || null;

  if (!hfRepoId && tok == null && !precision && !measuredAt) {
    return EVAL_MODELS;
  }

  const row = EVAL_MODELS.find((m) => m.id === SELF_HOSTED_ENDPOINT_ID);
  if (!row?.selfHosted) return EVAL_MODELS;
  const sh = row.selfHosted;

  if (hfRepoId && hfRepoId !== sh.hfRepoId) {
    // A different model is behind the endpoint now. Anything measured belonged
    // to the one it replaced, so it goes rather than being reattributed.
    sh.hfRepoId = hfRepoId;
    sh.measuredTokPerSec = null;
    sh.measuredAt = null;
    sh.precision = 'pending';
    const candidate = Object.values(SELF_HOSTED_CANDIDATES).find(
      (c) => c.hfRepoId === hfRepoId,
    );
    if (candidate) {
      row.label = `Self-hosted: ${candidate.label.replace(' (self-hosted)', '')}`;
      row.tier = candidate.tier;
      sh.license = candidate.license;
    } else {
      // Pasted into Deploy by hand, so the catalog has nothing to say about it.
      row.label = `Self-hosted: ${hfRepoId}`;
    }
  }

  if (tok != null) sh.measuredTokPerSec = tok;
  if (precision) sh.precision = precision;
  if (measuredAt) sh.measuredAt = measuredAt;

  // A large model alone defines weight 100. A small one has nothing to be a
  // ratio against until a large one has been benchmarked too, and inventing
  // one from a single number would be worse than the catalog fallback.
  if (row.tier === 'large' && sh.measuredTokPerSec != null) {
    row.relativeCostWeight = relativeCostFromThroughput({
      modelTokPerSec: sh.measuredTokPerSec,
      largeTokPerSec: sh.measuredTokPerSec,
    });
  }

  return EVAL_MODELS;
}

/** Test helper: allow re-apply after env changes. */
export function resetMeasuredThroughputApplied(): void {
  applied = false;
}
