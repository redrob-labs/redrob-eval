'use client';

import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export type EvolveRolloutStep = {
  /** 0-based rollout order within the run */
  index: number;
  candidateId: string;
  quality: number;
  totalTokens: number;
  meanRelativeCost: number;
  feasible: boolean;
  /** Best feasible quality seen through this step (null if none yet) */
  bestQualitySoFar: number | null;
  /** Tokens of that best-so-far candidate */
  bestTokensSoFar: number | null;
};

type ChartRow = {
  step: number;
  bestPct: number | null;
  qualityPct: number;
  tokens: number;
  feasible: boolean;
  candidateId: string;
  isBestPick: boolean;
};

function fmtDelta(n: number, digits = 1): string {
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}`;
}

export function EvolutionProgressChart({
  steps,
  qualityFloor,
}: {
  steps: EvolveRolloutStep[];
  qualityFloor?: number | null;
}) {
  const summary = useMemo(() => {
    const seed = steps[0];
    const last = steps[steps.length - 1];
    const bestIdx = (() => {
      let idx = -1;
      let bestQ = -Infinity;
      let bestT = Infinity;
      steps.forEach((s, i) => {
        if (!s.feasible) return;
        if (
          s.quality > bestQ + 1e-12 ||
          (Math.abs(s.quality - bestQ) <= 1e-12 && s.totalTokens < bestT)
        ) {
          bestQ = s.quality;
          bestT = s.totalTokens;
          idx = i;
        }
      });
      return idx;
    })();
    const best = bestIdx >= 0 ? steps[bestIdx] : null;
    const floorPct =
      qualityFloor != null && Number.isFinite(qualityFloor) ? qualityFloor * 100 : null;
    const bestPct = best ? best.quality * 100 : null;
    const seedPct = seed ? seed.quality * 100 : null;
    const qualityDelta =
      bestPct != null && seedPct != null ? bestPct - seedPct : null;
    const tokenDelta =
      best && seed ? best.totalTokens - seed.totalTokens : null;
    const cleared = best != null;
    const belowFloor = steps.filter((s) => !s.feasible).length;

    return {
      seed,
      last,
      best,
      bestIdx,
      floorPct,
      bestPct,
      seedPct,
      qualityDelta,
      tokenDelta,
      cleared,
      belowFloor,
      rolloutCount: steps.length,
    };
  }, [steps, qualityFloor]);

  const rows = useMemo<ChartRow[]>(
    () =>
      steps.map((s, i) => ({
        step: s.index + 1,
        bestPct: s.bestQualitySoFar != null ? s.bestQualitySoFar * 100 : null,
        qualityPct: s.quality * 100,
        tokens: s.totalTokens,
        feasible: s.feasible,
        candidateId: s.candidateId,
        isBestPick: i === summary.bestIdx,
      })),
    [steps, summary.bestIdx],
  );

  const yDomain = useMemo((): [number, number] => {
    const ys = rows.map((r) => r.qualityPct);
    if (summary.floorPct != null) ys.push(summary.floorPct);
    if (ys.length === 0) return [0, 100];
    const min = Math.min(...ys);
    const max = Math.max(...ys);
    const pad = Math.max((max - min) * 0.2, 4);
    return [Math.max(0, min - pad), Math.min(100, max + pad)];
  }, [rows, summary.floorPct]);

  if (steps.length === 0) return null;

  const statusLabel = !summary.cleared
    ? 'No feasible winner yet'
    : summary.qualityDelta != null && summary.qualityDelta > 0.05
      ? 'Improving'
      : summary.qualityDelta != null && summary.qualityDelta < -0.05
        ? 'Quality dropped'
        : 'Holding quality';

  return (
    <div className="evolve-glance">
      <div className="evolve-glance-head">
        <div>
          <p className="evolve-glance-kicker">Best so far</p>
          <p className="evolve-glance-hero">
            {summary.bestPct != null ? `${summary.bestPct.toFixed(0)}%` : '—'}
            <span>quality</span>
          </p>
        </div>
        <p className="evolve-glance-status" data-tone={summary.cleared ? 'ok' : 'warn'}>
          {statusLabel}
        </p>
      </div>

      <div className="evolve-glance-stats" aria-label="Run summary">
        <div>
          <span>vs seed</span>
          <strong
            data-tone={
              summary.qualityDelta == null
                ? undefined
                : summary.qualityDelta > 0.05
                  ? 'up'
                  : summary.qualityDelta < -0.05
                    ? 'down'
                    : undefined
            }
          >
            {summary.qualityDelta == null ? '—' : `${fmtDelta(summary.qualityDelta)} pts`}
          </strong>
        </div>
        <div>
          <span>tokens</span>
          <strong
            data-tone={
              summary.tokenDelta == null
                ? undefined
                : summary.tokenDelta < 0
                  ? 'up'
                  : summary.tokenDelta > 0
                    ? 'down'
                    : undefined
            }
          >
            {summary.best
              ? summary.tokenDelta == null
                ? summary.best.totalTokens.toFixed(0)
                : `${summary.best.totalTokens.toFixed(0)} (${fmtDelta(summary.tokenDelta, 0)})`
              : '—'}
          </strong>
        </div>
        <div>
          <span>rollouts</span>
          <strong>{summary.rolloutCount}</strong>
        </div>
        <div>
          <span>floor</span>
          <strong>
            {summary.floorPct != null ? `${summary.floorPct.toFixed(0)}%` : '—'}
          </strong>
        </div>
      </div>

      <p className="evolve-glance-caption">
        One line = best quality that cleared the floor, as the run goes left → right.
      </p>

      <div className="chart-frame chart-frame-glance">
        <ResponsiveContainer width="100%" height={200} minWidth={0}>
          <AreaChart data={rows} margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
            <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
            <XAxis
              dataKey="step"
              type="number"
              domain={[1, Math.max(rows.length, 1)]}
              allowDecimals={false}
              tick={{ fill: 'var(--chart-tick)', fontSize: 11 }}
              axisLine={{ stroke: 'var(--line)' }}
              tickLine={false}
            />
            <YAxis
              type="number"
              domain={yDomain}
              width={36}
              tick={{ fill: 'var(--chart-tick)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v: number) => `${Math.round(v)}%`}
            />
            {summary.floorPct != null ? (
              <ReferenceLine
                y={summary.floorPct}
                stroke="var(--warn)"
                strokeDasharray="4 4"
                strokeWidth={1.5}
              />
            ) : null}
            <Tooltip
              content={({ payload }) => {
                const row = payload?.[0]?.payload as ChartRow | undefined;
                if (!row) return null;
                return (
                  <div className="evolve-chart-tip">
                    <div className="evolve-chart-tip-title">
                      Rollout {row.step}
                      {row.isBestPick ? ' · best' : row.feasible ? '' : ' · below floor'}
                    </div>
                    <div>
                      This try <strong>{row.qualityPct.toFixed(1)}%</strong>
                      {' · '}
                      {row.tokens.toFixed(0)} tokens
                    </div>
                    {row.bestPct != null ? (
                      <div>
                        Best so far <strong>{row.bestPct.toFixed(1)}%</strong>
                      </div>
                    ) : null}
                  </div>
                );
              }}
            />
            <Area
              type="stepAfter"
              dataKey="bestPct"
              name="Best quality"
              stroke="var(--brand)"
              strokeWidth={3}
              fill="var(--brand)"
              fillOpacity={0.1}
              connectNulls
              isAnimationActive={false}
              dot={{ r: 3, fill: 'var(--brand)', stroke: 'var(--panel)', strokeWidth: 1 }}
              activeDot={{ r: 5 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="evolve-runway" role="list" aria-label="Each rollout">
        {rows.map((r) => {
          const height = Math.max(
            8,
            Math.round(
              ((r.qualityPct - yDomain[0]) / Math.max(yDomain[1] - yDomain[0], 1)) * 100,
            ),
          );
          return (
            <div
              key={r.step}
              role="listitem"
              className="evolve-runway-cell"
              data-feasible={r.feasible ? '1' : '0'}
              data-best={r.isBestPick ? '1' : '0'}
              title={`R${r.step}: ${r.qualityPct.toFixed(1)}% · ${r.tokens.toFixed(0)} tok${
                r.feasible ? '' : ' · below floor'
              }`}
            >
              <div className="evolve-runway-bar-wrap">
                <div className="evolve-runway-bar" style={{ height: `${height}%` }} />
              </div>
              <span className="evolve-runway-q">{Math.round(r.qualityPct)}</span>
              <span className="evolve-runway-n">R{r.step}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Rebuild best-so-far fields after appending a raw rollout. */
export function appendRolloutStep(
  prev: EvolveRolloutStep[],
  next: Omit<EvolveRolloutStep, 'bestQualitySoFar' | 'bestTokensSoFar'>,
): EvolveRolloutStep[] {
  const lastBestQ = prev.length ? prev[prev.length - 1]!.bestQualitySoFar : null;
  const lastBestT = prev.length ? prev[prev.length - 1]!.bestTokensSoFar : null;
  let bestQualitySoFar = lastBestQ;
  let bestTokensSoFar = lastBestT;
  if (next.feasible) {
    if (bestQualitySoFar == null || next.quality > bestQualitySoFar + 1e-12) {
      bestQualitySoFar = next.quality;
      bestTokensSoFar = next.totalTokens;
    } else if (
      Math.abs(next.quality - bestQualitySoFar) <= 1e-12 &&
      (bestTokensSoFar == null || next.totalTokens < bestTokensSoFar)
    ) {
      bestTokensSoFar = next.totalTokens;
    }
  }
  return [...prev, { ...next, bestQualitySoFar, bestTokensSoFar }];
}
