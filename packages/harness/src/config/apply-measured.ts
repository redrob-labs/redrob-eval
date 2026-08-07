/**
 * Apply measurements taken by /deploy (mirrored from the GPU host) onto EVAL_MODELS.
 *
 * Env (optional):
 *   MEASURED_TOK_PER_SEC_S / MEASURED_TOK_PER_SEC_L
 *   MEASURED_PRECISION_S / MEASURED_PRECISION_L  (bf16|fp8|mxfp4|pending)
 *   MEASURED_AT  (ISO date string)
 *
 * Mutates selfHosted fields and relativeCostWeight in place.
 * Relative cost: weight(m) = 100 * (tok/s_L / tok/s_m).
 */

import { EVAL_MODELS } from './models';
import {
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

/** Idempotent: mutates EVAL_MODELS self-hosted rows from MEASURED_* env. */
export function applyMeasuredThroughput(): typeof EVAL_MODELS {
  if (applied) return EVAL_MODELS;
  applied = true;

  const tokS = parsePositiveFloat(process.env.MEASURED_TOK_PER_SEC_S);
  const tokL = parsePositiveFloat(process.env.MEASURED_TOK_PER_SEC_L);
  const precS = parsePrecision(process.env.MEASURED_PRECISION_S);
  const precL = parsePrecision(process.env.MEASURED_PRECISION_L);
  const measuredAt = process.env.MEASURED_AT?.trim() || null;

  if (tokS == null && tokL == null && !precS && !precL && !measuredAt) {
    return EVAL_MODELS;
  }

  for (const m of EVAL_MODELS) {
    if (!m.selfHosted) continue;
    const sh = m.selfHosted;
    if (sh.axis === 'S') {
      if (tokS != null) sh.measuredTokPerSec = tokS;
      if (precS) sh.precision = precS;
      if (measuredAt) sh.measuredAt = measuredAt;
    } else {
      if (tokL != null) sh.measuredTokPerSec = tokL;
      if (precL) sh.precision = precL;
      if (measuredAt) sh.measuredAt = measuredAt;
    }
  }

  const largeTok =
    tokL ??
    EVAL_MODELS.find(
      (m) => m.selfHosted?.axis === 'L' && m.selfHosted.measuredTokPerSec != null,
    )?.selfHosted?.measuredTokPerSec ??
    null;

  if (largeTok != null && largeTok > 0) {
    for (const m of EVAL_MODELS) {
      if (!m.selfHosted?.measuredTokPerSec) continue;
      m.relativeCostWeight = relativeCostFromThroughput({
        modelTokPerSec: m.selfHosted.measuredTokPerSec,
        largeTokPerSec: largeTok,
      });
    }
  }

  return EVAL_MODELS;
}

/** Test helper: allow re-apply after env changes. */
export function resetMeasuredThroughputApplied(): void {
  applied = false;
}
