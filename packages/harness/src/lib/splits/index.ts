import type { EvalSample } from '../datasets/types';
import type { SplitBundle, SplitName } from './types';

/**
 * Refuse reporting a test-set metric from a split that was also optimized against.
 * This is the framework-level guard against train/test leakage.
 */
export function assertSplitIsolation(params: {
  optimizedAgainst: SplitName[];
  reported: SplitName;
}): void {
  const { optimizedAgainst, reported } = params;
  if (reported === 'test' && optimizedAgainst.includes('test')) {
    throw new Error(
      'Refusing to report a test-set metric: test was included in optimizedAgainst. ' +
        'Optimize on train, select on val, report test exactly once.',
    );
  }
}

/** Deterministic three-way split (seeded Fisher–Yates then contiguous slices). */
export function splitExamples<T extends EvalSample>(
  examples: T[],
  ratios: { train: number; val: number; test: number } = { train: 0.6, val: 0.2, test: 0.2 },
  seed = 42,
): SplitBundle<T & { split: SplitName }> {
  const sum = ratios.train + ratios.val + ratios.test;
  if (Math.abs(sum - 1) > 1e-9) {
    throw new Error(`split ratios must sum to 1 (got ${sum})`);
  }

  let t = seed >>> 0;
  const rand = () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };

  const shuffled = [...examples];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }

  const n = shuffled.length;
  const nTrain = Math.floor(n * ratios.train);
  const nVal = Math.floor(n * ratios.val);
  const train = shuffled.slice(0, nTrain).map((e) => ({ ...e, split: 'train' as const }));
  const val = shuffled.slice(nTrain, nTrain + nVal).map((e) => ({ ...e, split: 'val' as const }));
  const test = shuffled.slice(nTrain + nVal).map((e) => ({ ...e, split: 'test' as const }));
  return { train, val, test };
}

export type { SplitBundle, SplitName } from './types';
