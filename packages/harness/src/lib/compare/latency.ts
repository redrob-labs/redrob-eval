/**
 * Wall-clock latency under fan-out.
 *
 * With parallelSections = N, N calls fire concurrently and the user waits on
 * the slowest. Output tokens are split across sections:
 *
 *   wallClock = TTFT + (outputTokens / N) / tokensPerSecond
 *
 * NOT outputTokens / tokensPerSecond. As N rises, TTFT stops amortizing.
 */
export function wallClockSeconds(params: {
  outputTokens: number;
  parallelSections: number;
  tokensPerSecond: number;
  timeToFirstToken: number;
}): number {
  const n = Math.max(1, Math.floor(params.parallelSections));
  if (!(params.tokensPerSecond > 0)) {
    throw new Error('tokensPerSecond must be > 0');
  }
  if (!(params.timeToFirstToken >= 0)) {
    throw new Error('timeToFirstToken must be ≥ 0');
  }
  const outputTokensPerSection = params.outputTokens / n;
  return params.timeToFirstToken + outputTokensPerSection / params.tokensPerSecond;
}
