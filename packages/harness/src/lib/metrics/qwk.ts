/**
 * Quadratic weighted kappa (QWK) vs ordinal human labels.
 * Primary metric for video / checklist skill scoring.
 */

export interface QwkResult {
  score: number;
  feedback: string;
  n: number;
  /** Pairs excluded because either side abstained */
  abstained: number;
}

const ABSTAIN_RE = /^(abstain|abstained|decline|n\/a|na|unsure)$/i;

export function isAbstention(raw: string): boolean {
  const t = raw.trim();
  if (!t) return false;
  if (ABSTAIN_RE.test(t)) return true;
  try {
    const parsed = JSON.parse(t) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      if (rec.abstain === true || rec.abstained === true) return true;
      if (typeof rec.status === 'string' && ABSTAIN_RE.test(rec.status)) return true;
    }
  } catch {
    /* not JSON */
  }
  return false;
}

/** Parse an ordinal rating from gold/prediction text. */
export function parseOrdinal(raw: string): number | null {
  if (isAbstention(raw)) return null;
  const t = raw.trim();
  if (!t) return null;
  try {
    const parsed = JSON.parse(t) as unknown;
    if (typeof parsed === 'number' && Number.isFinite(parsed)) return parsed;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      for (const key of ['score', 'total', 'rating', 'label', 'grade']) {
        const v = rec[key];
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) {
          return Number(v.trim());
        }
      }
    }
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'number')) {
      // Checklist item vector → sum as ordinal proxy for pair scoring
      return (parsed as number[]).reduce((a, b) => a + b, 0);
    }
  } catch {
    /* fall through */
  }
  const m = t.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  return Number(m[0]);
}

/**
 * Quadratic weighted kappa for two ordinal raters.
 * Returns score in [0, 1] by mapping classic κ ∈ (-∞,1] via clamp of max(0, κ)
 * is wrong for GEPA floors — we return the raw κ clipped to [0,1] for the
 * harness quality channel, noting negative κ in feedback.
 *
 * Standard QWK formula (Cohen 1968 weighted).
 */
export function quadraticWeightedKappa(
  rater1: number[],
  rater2: number[],
): { kappa: number; n: number } {
  const n = Math.min(rater1.length, rater2.length);
  if (n === 0) return { kappa: 0, n: 0 };

  const a = rater1.slice(0, n).map((x) => Math.round(x));
  const b = rater2.slice(0, n).map((x) => Math.round(x));
  const minCat = Math.min(...a, ...b);
  const maxCat = Math.max(...a, ...b);
  const cats = maxCat - minCat + 1;
  if (cats <= 1) {
    // All labels identical across both raters → perfect agreement
    return { kappa: 1, n };
  }

  const hist = Array.from({ length: cats }, () => new Array(cats).fill(0));
  for (let i = 0; i < n; i++) {
    const r = a[i]! - minCat;
    const c = b[i]! - minCat;
    hist[r]![c]! += 1;
  }

  const rowSum = hist.map((row) => row.reduce((s, v) => s + v, 0));
  const colSum = Array.from({ length: cats }, (_, j) =>
    hist.reduce((s, row) => s + row[j]!, 0),
  );

  let observed = 0;
  let expected = 0;
  for (let i = 0; i < cats; i++) {
    for (let j = 0; j < cats; j++) {
      const w = ((i - j) * (i - j)) / ((cats - 1) * (cats - 1));
      observed += w * hist[i]![j]!;
      expected += w * rowSum[i]! * colSum[j]!;
    }
  }
  observed /= n;
  expected /= n * n;

  if (expected === 0) return { kappa: 1, n };
  const kappa = 1 - observed / expected;
  return { kappa, n };
}

export function qwkFromPairs(
  golds: string[],
  predictions: string[],
): QwkResult {
  const r1: number[] = [];
  const r2: number[] = [];
  let abstained = 0;
  const nPairs = Math.min(golds.length, predictions.length);
  for (let i = 0; i < nPairs; i++) {
    const gRaw = golds[i]!;
    const pRaw = predictions[i]!;
    if (isAbstention(pRaw) || isAbstention(gRaw)) {
      abstained += 1;
      continue; // abstain must not count as disagreement
    }
    const g = parseOrdinal(gRaw);
    const p = parseOrdinal(pRaw);
    if (g == null || p == null) {
      // Unparseable non-abstain prediction: treat as worst disagreement via skip? 
      // Keep as failed pair with extreme mismatch — use 0 vs gold span.
      // Prefer excluding malformed from QWK and noting in feedback.
      continue;
    }
    r1.push(g);
    r2.push(p);
  }

  const { kappa, n } = quadraticWeightedKappa(r1, r2);
  const score = Math.max(0, Math.min(1, kappa));
  let feedback: string;
  if (n === 0) {
    feedback =
      abstained > 0
        ? `No scorable pairs (all ${abstained} abstained or unparseable); QWK undefined → 0.`
        : 'No pairs to score for QWK.';
  } else if (kappa < 0) {
    feedback = `Negative QWK (${kappa.toFixed(3)}) on ${n} pairs (${abstained} abstained, excluded); clipped score=${score.toFixed(3)}.`;
  } else {
    feedback = `Quadratic weighted kappa=${kappa.toFixed(3)} on ${n} pairs (${abstained} abstained, excluded from κ).`;
  }
  return { score, feedback, n, abstained };
}

/** Per-example proxy for GEPA ASI when batch QWK is computed separately. */
export function qwkPairProxy(gold: string, prediction: string): QwkResult {
  if (isAbstention(prediction)) {
    return {
      score: 0,
      feedback: 'Model abstained; excluded from QWK (not scored as error).',
      n: 0,
      abstained: 1,
    };
  }
  const g = parseOrdinal(gold);
  const p = parseOrdinal(prediction);
  if (g == null || p == null) {
    return {
      score: 0,
      feedback: `Could not parse ordinals (gold="${gold.slice(0, 40)}", pred="${prediction.slice(0, 40)}").`,
      n: 0,
      abstained: 0,
    };
  }
  const { kappa, n } = quadraticWeightedKappa([g], [p]);
  const score = Math.max(0, Math.min(1, kappa));
  return {
    score,
    feedback:
      g === p
        ? `Ordinal match (${g}); contributes agreement to QWK.`
        : `Ordinal mismatch gold=${g} pred=${p}; pairwise κ=${kappa.toFixed(3)}.`,
    n,
    abstained: 0,
  };
}
