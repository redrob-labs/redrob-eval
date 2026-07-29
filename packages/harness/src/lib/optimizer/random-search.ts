import type { OptimizeContext, OptimizeEvent, Optimizer, Candidate, EvalBatch } from './types';
import { isFeasible, betterFeasible } from './gepa/fitness';

/** Mulberry32 — same family as dataset seeded sample. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Trivial baseline optimizer: sample candidates uniformly (or evaluate the sole
 * candidate) under maxRollouts. Keeps the best by quality-floor feasibility then tokens.
 */
export class RandomSearch implements Optimizer {
  async *optimize(ctx: OptimizeContext): AsyncGenerator<OptimizeEvent> {
    const { candidates, maxRollouts, seed, split, evaluate, signal, qualityFloor } = ctx;
    if (candidates.length === 0) {
      yield { type: 'error', message: 'RandomSearch requires at least one candidate' };
      return;
    }

    const rollouts = Math.max(1, Math.min(maxRollouts, candidates.length === 1 ? 1 : maxRollouts));
    yield {
      type: 'start',
      candidateCount: candidates.length,
      maxRollouts: rollouts,
      qualityFloor,
    };

    const rand = mulberry32(seed);
    let best: Candidate | null = null;
    let bestVal: EvalBatch | null = null;
    const baseline = candidates[0]!;
    let baselineVal: EvalBatch | null = null;
    let done = 0;

    try {
      for (let i = 0; i < rollouts; i++) {
        if (signal?.aborted) {
          yield { type: 'cancelled', message: 'Aborted' };
          return;
        }

        const candidate =
          candidates.length === 1
            ? candidates[0]!
            : candidates[Math.floor(rand() * candidates.length)]!;

        const trainExamples = split.train.length > 0 ? split.train : split.val;
        const valExamples = split.val.length > 0 ? split.val : split.train;

        const train = await evaluate(candidate, trainExamples);
        const val = await evaluate(candidate, valExamples);
        done += 1;
        if (candidate.id === baseline.id && !baselineVal) baselineVal = val;

        const feasible = isFeasible(val, qualityFloor);
        yield { type: 'rollout', index: i, candidate, train, val, feasible };
        if (!feasible) {
          yield {
            type: 'infeasible',
            candidateId: candidate.id,
            quality: val.quality,
            qualityFloor,
          };
        }

        if (!bestVal || betterFeasible(val, bestVal, qualityFloor)) {
          best = candidate;
          bestVal = val;
        }
      }

      yield {
        type: 'done',
        best,
        bestVal,
        test: null,
        baseline,
        baselineVal,
        rollouts: done,
        frontier: bestVal
          ? [
              {
                candidateId: best!.id,
                quality: bestVal.quality,
                totalTokens: bestVal.totalTokens,
                meanRelativeCost: bestVal.meanRelativeCost,
                feasible: isFeasible(bestVal, qualityFloor),
              },
            ]
          : [],
      };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        yield { type: 'cancelled', message: err.message };
        return;
      }
      yield {
        type: 'error',
        message: err instanceof Error ? err.message : 'RandomSearch failed',
      };
    }
  }
}
