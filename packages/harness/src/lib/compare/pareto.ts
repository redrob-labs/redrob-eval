/**
 * Non-dominated set across (quality, preference, cost, speed).
 * Maximize quality / preference / speed; minimize cost (relative %).
 * Null axes are skipped in pairwise comparisons (only shared present axes count).
 */

export type ParetoPoint = {
  id: string;
  quality: number | null;
  preference: number | null;
  /** Relative cost % — lower is better */
  cost: number | null;
  /** Wall-clock seconds — lower is better for dominance; we invert via speed-goodness:
   *  For Pareto we treat speed as maximize(-wallClock) when wallClock present. */
  speed: number | null; // wall-clock seconds (lower better) OR pass negated? 
  // We'll accept wallClockSeconds and treat lower as better internally.
  wallClockSeconds?: number | null;
};

function betterOrEqualOnAxis(
  a: number | null,
  b: number | null,
  maximize: boolean,
): boolean | null {
  if (a == null || b == null) return null; // axis not comparable
  if (maximize) return a >= b;
  return a <= b;
}

function strictlyBetterOnAxis(
  a: number | null,
  b: number | null,
  maximize: boolean,
): boolean | null {
  if (a == null || b == null) return null;
  if (maximize) return a > b;
  return a < b;
}

/** Does `a` dominate `b`? Requires at least one shared comparable axis and
 *  ≥ on all shared, > on at least one. */
export function dominates(a: ParetoPoint, b: ParetoPoint): boolean {
  const axes: Array<{ av: number | null; bv: number | null; max: boolean }> = [
    { av: a.quality, bv: b.quality, max: true },
    { av: a.preference, bv: b.preference, max: true },
    { av: a.cost, bv: b.cost, max: false },
    {
      av: a.wallClockSeconds ?? a.speed,
      bv: b.wallClockSeconds ?? b.speed,
      max: false, // lower wall-clock is better
    },
  ];

  let shared = 0;
  let allGe = true;
  let anyStrict = false;

  for (const ax of axes) {
    const ge = betterOrEqualOnAxis(ax.av, ax.bv, ax.max);
    if (ge === null) continue;
    shared += 1;
    if (!ge) allGe = false;
    const st = strictlyBetterOnAxis(ax.av, ax.bv, ax.max);
    if (st === true) anyStrict = true;
  }

  return shared > 0 && allGe && anyStrict;
}

export function nonDominatedSet(points: ParetoPoint[]): string[] {
  const ids: string[] = [];
  for (const p of points) {
    const dominated = points.some((q) => q.id !== p.id && dominates(q, p));
    if (!dominated) ids.push(p.id);
  }
  return ids;
}
