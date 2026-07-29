'use client';

import {
  CartesianGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import type { FrontierPoint } from '@redrob/harness';

export function EvolutionParetoChart({
  points,
  highlightId,
}: {
  points: FrontierPoint[];
  highlightId?: string | null;
}) {
  const data = points.map((p) => ({
    id: p.candidateId,
    x: p.totalTokens,
    y: p.quality * 100,
    feasible: p.feasible,
    cost: p.meanRelativeCost,
    fill: p.candidateId === highlightId
      ? '#0f766e'
      : p.feasible
        ? '#1d4ed8'
        : '#94a3b8',
  }));

  return (
    <div className="h-72 w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 12, right: 16, bottom: 12, left: 8 }}>
          <CartesianGrid stroke="rgba(15, 23, 42, 0.08)" strokeDasharray="3 3" />
          <XAxis
            type="number"
            dataKey="x"
            name="Tokens"
            tick={{ fill: '#64748b', fontSize: 11 }}
            label={{
              value: 'Tokens (prompt + completion)',
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
            unit="%"
            domain={[0, 100]}
            tick={{ fill: '#64748b', fontSize: 11 }}
            label={{
              value: 'Quality %',
              angle: -90,
              position: 'insideLeft',
              fill: '#64748b',
              fontSize: 11,
            }}
          />
          <ZAxis range={[90, 90]} />
          <Tooltip
            cursor={{ strokeDasharray: '3 3' }}
            content={({ payload }) => {
              const p = payload?.[0]?.payload as
                | {
                    id: string;
                    x: number;
                    y: number;
                    feasible: boolean;
                    cost: number;
                  }
                | undefined;
              if (!p) return null;
              return (
                <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs shadow-sm">
                  <div className="font-semibold text-slate-900">{p.id}</div>
                  <div className="text-slate-600">
                    Quality {p.y.toFixed(1)}% · Tokens {p.x.toFixed(0)} · Rel. cost{' '}
                    {p.cost.toFixed(1)}
                    {p.feasible ? '' : ' · infeasible'}
                  </div>
                </div>
              );
            }}
          />
          <Scatter data={data} fill="#1d4ed8" />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
