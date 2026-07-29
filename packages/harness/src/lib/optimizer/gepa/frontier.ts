import type { Candidate, EvalBatch, Example } from '../types';

/**
 * Instance-level Pareto frontier: a candidate is on the frontier if it
 * achieves the best score on at least one eval example.
 */
export class InstanceFrontier {
  /** exampleId → { candidateId, score } */
  private best = new Map<string, { candidateId: string; score: number }>();
  /** candidateId → number of examples it leads */
  private coverage = new Map<string, number>();

  /** Update frontier from a full eval batch for one candidate. */
  update(candidateId: string, batch: EvalBatch): void {
    for (const o of batch.outcomes) {
      const prev = this.best.get(o.exampleId);
      if (!prev || o.score > prev.score) {
        if (prev) {
          this.coverage.set(prev.candidateId, (this.coverage.get(prev.candidateId) ?? 1) - 1);
        }
        this.best.set(o.exampleId, { candidateId, score: o.score });
        this.coverage.set(candidateId, (this.coverage.get(candidateId) ?? 0) + 1);
      } else if (prev && o.score === prev.score && prev.candidateId === candidateId) {
        // already leading
      }
    }
    // Clean zero coverage
    for (const [id, c] of [...this.coverage.entries()]) {
      if (c <= 0) this.coverage.delete(id);
    }
  }

  getCoverage(): Record<string, number> {
    return Object.fromEntries(this.coverage.entries());
  }

  frontierIds(): string[] {
    return [...this.coverage.keys()].filter((id) => (this.coverage.get(id) ?? 0) > 0);
  }

  /**
   * Select a candidate with probability proportional to coverage.
   * Falls back to uniform over provided pool if frontier empty.
   */
  selectCandidate(
    pool: Candidate[],
    rand: () => number,
  ): Candidate {
    const ids = this.frontierIds();
    const byId = new Map(pool.map((c) => [c.id, c]));

    if (ids.length === 0) {
      return pool[Math.floor(rand() * pool.length)]!;
    }

    let total = 0;
    const weights: Array<{ id: string; w: number }> = [];
    for (const id of ids) {
      if (!byId.has(id)) continue;
      const w = Math.max(1, this.coverage.get(id) ?? 1);
      weights.push({ id, w });
      total += w;
    }
    if (weights.length === 0 || total <= 0) {
      return pool[Math.floor(rand() * pool.length)]!;
    }

    let r = rand() * total;
    for (const { id, w } of weights) {
      r -= w;
      if (r <= 0) return byId.get(id)!;
    }
    return byId.get(weights[weights.length - 1]!.id)!;
  }
}

/** Sample a minibatch from train without replacement. */
export function sampleMinibatch(
  examples: Example[],
  size: number,
  rand: () => number,
): Example[] {
  if (examples.length === 0) return [];
  const n = Math.min(size, examples.length);
  const copy = [...examples];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, n);
}
