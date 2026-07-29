import type { ProviderId } from '../../../config/models';
import type {
  Candidate,
  EvalBatch,
  OptimizeContext,
  OptimizeEvent,
  Optimizer,
} from '../types';
import { InstanceFrontier, sampleMinibatch } from './frontier';
import { betterFeasible, isFeasible, toFrontierPoint } from './fitness';
import { makeReflectiveDataset } from './make-reflective-dataset';
import { pickMergeParents, systemAwareMerge } from './merge';
import { reflectAndMutate } from './reflect';

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function meanBatchQuality(batch: EvalBatch, subset: EvalBatch['outcomes']): number {
  if (subset.length === 0) return 0;
  return subset.reduce((s, o) => s + o.score, 0) / subset.length;
}

/**
 * GEPA (Genetic-Pareto) — TypeScript reimplementation of the paper loop.
 * Not a port of the reference Python module layout.
 */
export class Gepa implements Optimizer {
  async *optimize(ctx: OptimizeContext): AsyncGenerator<OptimizeEvent> {
    const {
      candidates: seeds,
      maxRollouts,
      qualityFloor,
      minibatchSize,
      mergeEvery,
      seed,
      split,
      evaluate,
      reflect,
      demoPool,
      modelCatalog,
      reflectModelId,
      signal,
    } = ctx;

    if (seeds.length === 0) {
      yield { type: 'error', message: 'GEPA requires at least one seed candidate' };
      return;
    }

    const rand = mulberry32(seed);
    const pool: Candidate[] = seeds.map((c) => ({ ...c, demos: [...c.demos], lessons: [...c.lessons] }));
    const baselineSeed = pool[0]!;
    let baselineVal: EvalBatch | null = null;
    const valScores = new Map<string, EvalBatch>();
    const frontier = new InstanceFrontier();
    let rollouts = 0;
    let acceptedSinceMerge = 0;

    const train = split.train.length > 0 ? split.train : split.val;
    const val = split.val.length > 0 ? split.val : split.train;
    const paretoSet = val.length > 0 ? val : train;

    yield {
      type: 'start',
      candidateCount: pool.length,
      maxRollouts,
      qualityFloor,
    };

    try {
      // Initialize: evaluate seed(s) on Pareto set
      for (const c of [...pool]) {
        if (signal?.aborted) {
          yield { type: 'cancelled', message: 'Aborted' };
          return;
        }
        const batch = await evaluate(c, paretoSet);
        rollouts += 1;
        valScores.set(c.id, batch);
        frontier.update(c.id, batch);
        if (c.id === baselineSeed.id) baselineVal = batch;
        const feasible = isFeasible(batch, qualityFloor);
        yield {
          type: 'rollout',
          index: rollouts - 1,
          candidate: c,
          train: batch,
          val: batch,
          feasible,
        };
        if (!feasible) {
          yield {
            type: 'infeasible',
            candidateId: c.id,
            quality: batch.quality,
            qualityFloor,
          };
        }
        if (rollouts >= maxRollouts) break;
      }

      yield {
        type: 'frontier',
        points: [...valScores.entries()].map(([id, b]) =>
          toFrontierPoint(id, b, qualityFloor),
        ),
        coverage: frontier.getCoverage(),
      };

      while (rollouts < maxRollouts) {
        if (signal?.aborted) {
          yield { type: 'cancelled', message: 'Aborted' };
          return;
        }

        const parent = frontier.selectCandidate(pool, rand);
        const minibatch = sampleMinibatch(train, Math.max(1, minibatchSize), rand);
        const parentMini = await evaluate(parent, minibatch);
        rollouts += 1;

        const reflectiveDataset = makeReflectiveDataset({
          examples: minibatch,
          batch: parentMini,
        });

        let child: Candidate;
        let lesson: string;

        if (reflect) {
          child = await reflect({
            parent,
            reflectiveDataset,
            lessons: parent.lessons,
          });
          lesson = child.lessons[child.lessons.length - 1] ?? 'custom reflect';
        } else {
          const mutated = await reflectAndMutate({
            parent,
            reflectiveDataset,
            lessons: parent.lessons,
            reflectModel: {
              providerId: (ctx.reflectProviderId as ProviderId) ||
                (parent.model.providerId as ProviderId) ||
                'openrouter',
              modelId: reflectModelId.includes('/')
                ? reflectModelId.replace(/^or\//, '')
                : parent.model.modelId,
            },
            demoPool,
            modelCatalog,
            rand,
            customGoal: ctx.customGoal,
          });
          child = mutated.child;
          lesson = mutated.lesson;
        }

        yield {
          type: 'reflect',
          parentId: parent.id,
          childId: child.id,
          lesson,
        };

        const childMini = await evaluate(child, minibatch);
        rollouts += 1;

        const parentQ = meanBatchQuality(parentMini, parentMini.outcomes);
        const childQ = meanBatchQuality(childMini, childMini.outcomes);
        const improved = childQ > parentQ + 1e-9;

        if (improved) {
          pool.push(child);
          const childVal = await evaluate(child, paretoSet);
          rollouts += 1;
          valScores.set(child.id, childVal);
          frontier.update(child.id, childVal);
          acceptedSinceMerge += 1;

          const feasible = isFeasible(childVal, qualityFloor);
          yield {
            type: 'rollout',
            index: rollouts - 1,
            candidate: child,
            train: childMini,
            val: childVal,
            feasible,
          };
          if (!feasible) {
            yield {
              type: 'infeasible',
              candidateId: child.id,
              quality: childVal.quality,
              qualityFloor,
            };
          }
        }

        // Periodic system-aware merge
        if (
          mergeEvery > 0 &&
          acceptedSinceMerge >= mergeEvery &&
          rollouts < maxRollouts
        ) {
          const parents = pickMergeParents(
            frontier.frontierIds(),
            frontier.getCoverage(),
            pool,
            rand,
          );
          if (parents) {
            const [a, b] = parents;
            const merged = systemAwareMerge(a, b);
            pool.push(merged);
            const mergedVal = await evaluate(merged, paretoSet);
            rollouts += 1;
            valScores.set(merged.id, mergedVal);
            frontier.update(merged.id, mergedVal);
            acceptedSinceMerge = 0;
            yield {
              type: 'merge',
              parentA: a.id,
              parentB: b.id,
              childId: merged.id,
            };
            yield {
              type: 'rollout',
              index: rollouts - 1,
              candidate: merged,
              train: mergedVal,
              val: mergedVal,
              feasible: isFeasible(mergedVal, qualityFloor),
            };
          } else {
            acceptedSinceMerge = 0;
          }
        }

        yield {
          type: 'frontier',
          points: [...valScores.entries()].map(([id, b]) =>
            toFrontierPoint(id, b, qualityFloor),
          ),
          coverage: frontier.getCoverage(),
        };
      }

      // Select best feasible on val
      let best: Candidate | null = null;
      let bestVal: EvalBatch | null = null;
      for (const c of pool) {
        const b = valScores.get(c.id);
        if (!b) continue;
        if (!bestVal || betterFeasible(b, bestVal, qualityFloor)) {
          best = c;
          bestVal = b;
        }
      }

      // Test exactly once at the end (caller must not have optimized against test)
      let test: EvalBatch | null = null;
      if (best && split.test.length > 0) {
        test = await evaluate(best, split.test);
        rollouts += 1;
      }

      yield {
        type: 'done',
        best,
        bestVal,
        test,
        baseline: baselineSeed,
        baselineVal: baselineVal ?? valScores.get(baselineSeed.id) ?? null,
        rollouts,
        frontier: [...valScores.entries()].map(([id, b]) =>
          toFrontierPoint(id, b, qualityFloor),
        ),
      };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        yield { type: 'cancelled', message: err.message };
        return;
      }
      yield {
        type: 'error',
        message: err instanceof Error ? err.message : 'GEPA failed',
      };
    }
  }
}

export { makeReflectiveDataset } from './make-reflective-dataset';
export { InstanceFrontier, sampleMinibatch } from './frontier';
export { systemAwareMerge, pickMergeParents } from './merge';
export { isFeasible, betterFeasible, toFrontierPoint } from './fitness';
