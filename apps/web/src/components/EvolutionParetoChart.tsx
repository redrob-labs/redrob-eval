'use client';

import { useMemo } from 'react';
import {
  CartesianGrid,
  Cell,
  LabelList,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import type { FrontierPoint } from '@redrob/harness';

type PointRow = {
  id: string;
  label: string;
  x: number;
  y: number;
  feasible: boolean;
  cost: number;
  fill: string;
  role: 'best' | 'seed' | 'feasible' | 'infeasible';
};

function paddedDomain(values: number[], padRatio = 0.14): [number, number] {
  if (values.length === 0) return [0, 1];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) {
    const pad = Math.max(Math.abs(min) * padRatio, 1);
    return [min - pad, max + pad];
  }
  const pad = (max - min) * padRatio;
  return [min - pad, max + pad];
}

function shortLabel(params: {
  id: string;
  role: PointRow['role'];
  pointCount: number;
}): string {
  if (params.role === 'best') return 'Best';
  if (params.role === 'seed') return 'Seed';
  if (params.pointCount <= 6) {
    const tail = params.id.replace(/^.*_/, '');
    return tail.slice(0, 8) || params.id.slice(0, 8);
  }
  return '';
}

function buildTakeaway(params: {
  feasible: PointRow[];
  best: PointRow | undefined;
  seed: PointRow | undefined;
  qualityFloorPct: number | null;
}): string {
  const { feasible, best, seed, qualityFloorPct } = params;
  if (feasible.length === 0) {
    return qualityFloorPct != null
      ? `No configs cleared the ${qualityFloorPct.toFixed(0)}% quality floor yet.`
      : 'No feasible configs on the frontier yet.';
  }
  if (best && seed && best.id !== seed.id) {
    const tokenDelta = seed.x - best.x;
    const qualityDelta = best.y - seed.y;
    const tokenPart =
      tokenDelta > 0
        ? `${tokenDelta.toFixed(0)} fewer tokens than seed`
        : tokenDelta < 0
          ? `${Math.abs(tokenDelta).toFixed(0)} more tokens than seed`
          : 'same tokens as seed';
    const qualityPart =
      qualityDelta > 0.05
        ? `, +${qualityDelta.toFixed(1)} pts quality`
        : qualityDelta < -0.05
          ? `, ${qualityDelta.toFixed(1)} pts quality`
          : ', similar quality';
    return `Best pick: ${tokenPart}${qualityPart}. Aim up and left.`;
  }
  if (best) {
    return `Best feasible: ${best.y.toFixed(1)}% quality at ${best.x.toFixed(0)} tokens. Aim up and left (better + cheaper).`;
  }
  return 'Each point is a candidate config. Prefer points above the floor and further left.';
}

export function EvolutionParetoChart({
  points,
  highlightId,
  baselineId,
  qualityFloor,
}: {
  points: FrontierPoint[];
  highlightId?: string | null;
  /** Seed / baseline candidate id — labeled on the chart when present */
  baselineId?: string | null;
  /** 0–1 quality floor; drawn as a horizontal reference when set */
  qualityFloor?: number | null;
}) {
  const data = useMemo(() => {
    const rows: PointRow[] = points.map((p) => {
      const isBest = Boolean(highlightId && p.candidateId === highlightId);
      const isSeed = Boolean(baselineId && p.candidateId === baselineId) && !isBest;
      const role: PointRow['role'] = isBest
        ? 'best'
        : isSeed
          ? 'seed'
          : p.feasible
            ? 'feasible'
            : 'infeasible';
      return {
        id: p.candidateId,
        label: '',
        x: p.totalTokens,
        y: p.quality * 100,
        feasible: p.feasible,
        cost: p.meanRelativeCost,
        fill:
          role === 'best'
            ? '#2b52ff'
            : role === 'seed'
              ? '#c2410c'
              : p.feasible
                ? '#64748b'
                : '#cbd5e1',
        role,
      };
    });
    const sorted = rows.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    for (const row of sorted) {
      row.label = shortLabel({ id: row.id, role: row.role, pointCount: sorted.length });
    }
    return sorted;
  }, [points, highlightId, baselineId]);

  const feasible = useMemo(() => data.filter((p) => p.feasible), [data]);
  const infeasible = useMemo(() => data.filter((p) => !p.feasible), [data]);
  const best = useMemo(
    () => data.find((p) => p.role === 'best') ?? feasible[0],
    [data, feasible],
  );
  const seed = useMemo(() => data.find((p) => p.role === 'seed'), [data]);

  const xDomain = useMemo(() => paddedDomain(data.map((p) => p.x)), [data]);
  const yDomain = useMemo(() => {
    const ys = data.map((p) => p.y);
    if (qualityFloor != null && Number.isFinite(qualityFloor)) {
      ys.push(qualityFloor * 100);
    }
    const [lo, hi] = paddedDomain(ys);
    return [Math.max(0, lo), Math.min(100, hi)] as [number, number];
  }, [data, qualityFloor]);

  const qualityFloorPct =
    qualityFloor != null && Number.isFinite(qualityFloor) ? qualityFloor * 100 : null;

  const takeaway = useMemo(
    () =>
      buildTakeaway({
        feasible,
        best,
        seed,
        qualityFloorPct,
      }),
    [feasible, best, seed, qualityFloorPct],
  );

  if (data.length === 0) return null;

  return (
    <div className="evolve-chart">
      <div className="evolve-chart-read">
        <strong>How to read</strong>
        <p>
          Each dot is one config GEPA tried. <em>Up</em> = higher quality, <em>left</em> = fewer
          tokens (cheaper). The line is the feasible frontier — only points on or above the
          quality floor count.
        </p>
      </div>

      <p className="evolve-chart-takeaway">{takeaway}</p>

      <div className="chart-frame">
        <ResponsiveContainer width="100%" height={288} minWidth={0}>
          <ScatterChart margin={{ top: 18, right: 20, bottom: 28, left: 10 }}>
            <CartesianGrid stroke="rgba(15, 23, 42, 0.08)" strokeDasharray="3 3" />
            <XAxis
              type="number"
              dataKey="x"
              name="Tokens"
              domain={xDomain}
              allowDataOverflow
              tick={{ fill: '#64748b', fontSize: 11 }}
              label={{
                value: '← cheaper (tokens)     costlier →',
                position: 'insideBottom',
                offset: -10,
                fill: '#64748b',
                fontSize: 11,
              }}
            />
            <YAxis
              type="number"
              dataKey="y"
              name="Quality"
              unit="%"
              domain={yDomain}
              allowDataOverflow
              tick={{ fill: '#64748b', fontSize: 11 }}
              label={{
                value: 'Quality %  ↑ better',
                angle: -90,
                position: 'insideLeft',
                fill: '#64748b',
                fontSize: 11,
              }}
            />
            <ZAxis range={[120, 120]} />
            {qualityFloorPct != null ? (
              <ReferenceLine
                y={qualityFloorPct}
                stroke="#a16207"
                strokeDasharray="4 4"
                label={{
                  value: `floor ${qualityFloorPct.toFixed(0)}%`,
                  fill: '#a16207',
                  fontSize: 10,
                  position: 'insideTopRight',
                }}
              />
            ) : null}
            <Tooltip
              cursor={{ strokeDasharray: '3 3' }}
              content={({ payload }) => {
                const p = payload?.[0]?.payload as PointRow | undefined;
                if (!p) return null;
                const roleLabel =
                  p.role === 'best'
                    ? 'Best feasible'
                    : p.role === 'seed'
                      ? 'Seed / baseline'
                      : p.feasible
                        ? 'Feasible'
                        : 'Below floor';
                return (
                  <div className="evolve-chart-tip">
                    <div className="evolve-chart-tip-title">{roleLabel}</div>
                    <div className="evolve-chart-tip-id">{p.id}</div>
                    <div>
                      Quality <strong>{p.y.toFixed(1)}%</strong>
                      {' · '}
                      Tokens <strong>{p.x.toFixed(0)}</strong>
                      {' · '}
                      Rel. cost <strong>{p.cost.toFixed(1)}</strong>
                    </div>
                    {!p.feasible ? (
                      <div className="evolve-chart-tip-warn">
                        Below quality floor — ignored when picking a winner.
                      </div>
                    ) : null}
                  </div>
                );
              }}
            />
            <Scatter
              name="Feasible frontier"
              data={feasible}
              fill="#64748b"
              line={{ stroke: '#2b52ff', strokeWidth: 2 }}
              lineJointType="linear"
              isAnimationActive={false}
            >
              {feasible.map((entry) => (
                <Cell key={entry.id} fill={entry.fill} />
              ))}
              <LabelList
                dataKey="label"
                position="top"
                offset={8}
                style={{ fill: '#334155', fontSize: 10, fontWeight: 600 }}
              />
            </Scatter>
            {infeasible.length > 0 ? (
              <Scatter
                name="Infeasible"
                data={infeasible}
                fill="#94a3b8"
                isAnimationActive={false}
              >
                {infeasible.map((entry) => (
                  <Cell key={entry.id} fill={entry.fill} />
                ))}
              </Scatter>
            ) : null}
          </ScatterChart>
        </ResponsiveContainer>
      </div>

      <ul className="evolve-chart-legend" aria-label="Chart legend">
        <li>
          <span className="evolve-swatch" data-tone="best" />
          Best feasible
        </li>
        <li>
          <span className="evolve-swatch" data-tone="seed" />
          Seed / baseline
        </li>
        <li>
          <span className="evolve-swatch" data-tone="feasible" />
          Other feasible
        </li>
        <li>
          <span className="evolve-swatch" data-tone="infeasible" />
          Below floor
        </li>
        <li>
          <span className="evolve-swatch" data-tone="line" />
          Frontier line
        </li>
        <li>
          <span className="evolve-swatch" data-tone="floor" />
          Quality floor
        </li>
      </ul>
    </div>
  );
}
