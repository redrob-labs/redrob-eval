import type { AxisScore } from './types';

function nullScores(n: number, feedback: string): AxisScore[] {
  return Array.from({ length: n }, () => ({ score: null, feedback }));
}

/** Quality: ratio to max in the compared set × 100. Missing stays null. */
export function normalizeQuality(values: Array<number | null>): AxisScore[] {
  const present = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (present.length === 0) {
    return nullScores(values.length, 'No quality scores in compared set.');
  }
  const max = Math.max(...present);
  if (!(max > 0)) {
    return values.map((v) =>
      v == null
        ? { score: null, feedback: 'Quality missing.' }
        : { score: 0, feedback: 'Quality max in set is 0.' },
    );
  }
  return values.map((v) => {
    if (v == null || !Number.isFinite(v)) {
      return { score: null, feedback: 'Quality missing — not imputed.' };
    }
    const score = (v / max) * 100;
    return {
      score,
      feedback: `Quality ${score.toFixed(1)} (ratio to set max ${max}).`,
    };
  });
}

/**
 * Preference via Arena Elo → expected win rate against the top Elo in the set,
 * then × 100. Elo is log-odds; do not min-max linearly.
 */
export function normalizePreferenceElo(elos: Array<number | null>): AxisScore[] {
  const present = elos.filter((v): v is number => v != null && Number.isFinite(v));
  if (present.length === 0) {
    return nullScores(elos.length, 'No Arena Elo in compared set.');
  }
  const eloMax = Math.max(...present);
  return elos.map((elo) => {
    if (elo == null || !Number.isFinite(elo)) {
      return { score: null, feedback: 'Arena Elo missing — not imputed.' };
    }
    const expectedWin = 1 / (1 + 10 ** ((eloMax - elo) / 400));
    const score = expectedWin * 100;
    return {
      score,
      feedback: `Expected win rate vs top Elo (${eloMax}): ${(expectedWin * 100).toFixed(1)}%.`,
    };
  });
}

/**
 * Cost: log-normalize relative cost %. Lower cost → higher score.
 * score = 100 * (log(max) − log(c)) / (log(max) − log(min)) when range > 0.
 */
export function normalizeCostLog(relativeCostPcts: Array<number | null>): AxisScore[] {
  const present = relativeCostPcts.filter(
    (v): v is number => v != null && Number.isFinite(v) && v > 0,
  );
  if (present.length === 0) {
    return nullScores(relativeCostPcts.length, 'No relative costs in compared set.');
  }
  const min = Math.min(...present);
  const max = Math.max(...present);
  const logMin = Math.log(min);
  const logMax = Math.log(max);
  const span = logMax - logMin;

  return relativeCostPcts.map((c, i) => {
    const upperBound = false; // caller may overlay
    void i;
    if (c == null || !Number.isFinite(c) || c <= 0) {
      return { score: null, feedback: 'Relative cost missing — not imputed.' };
    }
    if (span < 1e-12) {
      return {
        score: 100,
        feedback: 'All costs equal after log; full credit.',
        upperBound,
      };
    }
    const score = 100 * ((logMax - Math.log(c)) / span);
    return {
      score,
      feedback: `Log-normalized cost score ${score.toFixed(1)} (lower relative % is better).`,
      upperBound,
    };
  });
}

/**
 * Speed: normalize wall clock against goodEnoughSeconds.
 * At or below ceiling → 100; slower → linearly down toward 0 at 2× ceiling
 * (beyond which additional slowness still approaches 0, never negative).
 */
export function normalizeSpeed(
  wallClocks: Array<number | null>,
  goodEnoughSeconds: number,
): AxisScore[] {
  if (!(goodEnoughSeconds > 0)) {
    throw new Error('goodEnoughSeconds must be > 0');
  }
  return wallClocks.map((w) => {
    if (w == null || !Number.isFinite(w) || w < 0) {
      return { score: null, feedback: 'Wall-clock missing — not imputed.' };
    }
    if (w <= goodEnoughSeconds) {
      return {
        score: 100,
        feedback: `Wall-clock ${w.toFixed(2)}s ≤ good-enough ceiling ${goodEnoughSeconds}s.`,
      };
    }
    // Linear decay from 100 at ceiling to 0 at 3× ceiling
    const score = Math.max(0, 100 * (1 - (w - goodEnoughSeconds) / (2 * goodEnoughSeconds)));
    return {
      score,
      feedback: `Wall-clock ${w.toFixed(2)}s vs ceiling ${goodEnoughSeconds}s → speed ${score.toFixed(1)}.`,
    };
  });
}
