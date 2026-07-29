/**
 * Cohen's kappa for per-item binary checklist agreement.
 */

export interface CohensKappaResult {
  score: number;
  feedback: string;
  n: number;
}

function parseBinaryLabels(raw: string): number[] | null {
  const t = raw.trim();
  if (!t) return null;
  try {
    const parsed = JSON.parse(t) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map((x) => {
        if (typeof x === 'boolean') return x ? 1 : 0;
        if (typeof x === 'number') return x >= 0.5 ? 1 : 0;
        if (typeof x === 'string') {
          const s = x.trim().toLowerCase();
          if (s === '1' || s === 'true' || s === 'yes' || s === 'pass') return 1;
          return 0;
        }
        return 0;
      });
    }
    if (parsed && typeof parsed === 'object') {
      const rec = parsed as Record<string, unknown>;
      if (Array.isArray(rec.items)) return parseBinaryLabels(JSON.stringify(rec.items));
      if (Array.isArray(rec.checklist)) return parseBinaryLabels(JSON.stringify(rec.checklist));
    }
  } catch {
    /* fall through */
  }
  // Comma / space separated 0/1
  const parts = t.split(/[,;\s]+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (!parts.every((p) => /^(0|1|true|false|yes|no|pass|fail)$/i.test(p))) {
    return null;
  }
  return parts.map((p) => (/^(1|true|yes|pass)$/i.test(p) ? 1 : 0));
}

/**
 * Cohen's κ for two binary sequences (item-wise).
 * When lengths differ, truncate to the shorter.
 */
export function cohensKappaBinary(a: number[], b: number[]): { kappa: number; n: number } {
  const n = Math.min(a.length, b.length);
  if (n === 0) return { kappa: 0, n: 0 };

  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! >= 0.5 ? 1 : 0;
    const y = b[i]! >= 0.5 ? 1 : 0;
    if (x === 1 && y === 1) tp += 1;
    else if (x === 0 && y === 0) tn += 1;
    else if (x === 0 && y === 1) fp += 1;
    else fn += 1;
  }

  const po = (tp + tn) / n;
  const pe =
    (((tp + fn) / n) * ((tp + fp) / n) + ((tn + fp) / n) * ((tn + fn) / n));
  if (pe === 1) return { kappa: po === 1 ? 1 : 0, n };
  const kappa = (po - pe) / (1 - pe);
  return { kappa, n };
}

export function cohensKappaFromPair(gold: string, prediction: string): CohensKappaResult {
  const g = parseBinaryLabels(gold);
  const p = parseBinaryLabels(prediction);
  if (!g || !p) {
    return {
      score: 0,
      feedback: 'Could not parse binary checklist vectors for Cohen\'s kappa.',
      n: 0,
    };
  }
  const { kappa, n } = cohensKappaBinary(g, p);
  const score = Math.max(0, Math.min(1, kappa));
  return {
    score,
    feedback:
      kappa < 0
        ? `Negative Cohen's κ (${kappa.toFixed(3)}) on ${n} items; clipped=${score.toFixed(3)}.`
        : `Cohen's κ=${kappa.toFixed(3)} on ${n} binary checklist items.`,
    n,
  };
}

export { parseBinaryLabels };
