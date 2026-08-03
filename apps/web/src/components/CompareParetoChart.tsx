'use client';

import {
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import type { RankedModel } from '@redrob/harness';

type Point = {
  id: string;
  label: string;
  x: number;
  y: number;
  frontier: boolean;
  fill: string;
};

/**
 * Relative cost % (x) vs quality score (y) — same visual idiom as Text/Evolve Pareto.
 */
export function CompareParetoChart({ ranked }: { ranked: RankedModel[] }) {
  const data: Point[] = ranked
    .filter((r) => r.axes.relativeCostPct != null && r.axes.quality.score != null)
    .map((r) => ({
      id: r.modelId,
      label: r.label,
      x: r.axes.relativeCostPct as number,
      y: r.axes.quality.score as number,
      frontier: r.onParetoFrontier,
      fill: r.onParetoFrontier ? '#0f766e' : '#94a3b8',
    }));

  if (data.length === 0) {
    return (
      <p className="text-xs text-slate-500">
        Pareto needs models with both relative cost and quality scores.
      </p>
    );
  }

  return (
    <div className="w-full min-w-0">
      <div className="chart-frame">
        <ResponsiveContainer width="100%" height={288} minWidth={0}>
          <ScatterChart margin={{ top: 12, right: 16, bottom: 12, left: 8 }}>
            <CartesianGrid stroke="rgba(15, 23, 42, 0.08)" strokeDasharray="3 3" />
            <XAxis
              type="number"
              dataKey="x"
              name="Relative cost"
              unit="%"
              tick={{ fill: '#64748b', fontSize: 11 }}
              label={{
                value: 'Relative cost (% of baseline)',
                position: 'insideBottom',
                offset: -4,
                fill: '#64748b',
                fontSize: 11,
              }}
            />
            <YAxis
              type="number"
              dataKey="y"
              name="Quality"
              tick={{ fill: '#64748b', fontSize: 11 }}
              label={{
                value: 'Quality (normalized)',
                angle: -90,
                position: 'insideLeft',
                fill: '#64748b',
                fontSize: 11,
              }}
            />
            <ZAxis range={[80, 80]} />
            <Tooltip
              cursor={{ strokeDasharray: '3 3' }}
              content={({ payload }) => {
                const p = payload?.[0]?.payload as Point | undefined;
                if (!p) return null;
                return (
                  <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs shadow-sm">
                    <div className="font-semibold text-slate-900">{p.label}</div>
                    <div className="text-slate-600">
                      Cost {p.x.toFixed(1)}% · Quality {p.y.toFixed(1)}
                      {p.frontier ? ' · frontier' : ''}
                    </div>
                  </div>
                );
              }}
            />
            <Scatter data={data} name="models">
              {data.map((d) => (
                <Cell
                  key={d.id}
                  fill={d.fill}
                  stroke={d.frontier ? '#0f766e' : undefined}
                  strokeWidth={d.frontier ? 2 : 0}
                />
              ))}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-2 text-[11px] text-slate-500">
        Teal = non-dominated on (quality, preference, cost, speed). Aim up and left.
      </p>
    </div>
  );
}
