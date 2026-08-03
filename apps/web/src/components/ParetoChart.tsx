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
import type { EvalRunResult, EvalTargetSummary } from '@redrob/harness';
import { pct } from '@/lib/utils';

const COLORS = ['#0f766e', '#c2410c', '#1d4ed8', '#a16207', '#be123c', '#4338ca'];

function pointColor(i: number, kind: EvalTargetSummary['kind']): string {
  if (kind === 'router') return '#ea580c';
  return COLORS[i % COLORS.length]!;
}

export function ParetoChart({ result }: { result: EvalRunResult }) {
  const data = result.targets.map((t, i) => ({
    id: t.targetId,
    label: t.label,
    kind: t.kind,
    x: t.relativeCostPct,
    y: t.quality * 100,
    fill: pointColor(i, t.kind),
  }));

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
                value: 'Relative cost (% of large baseline)',
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
            <ZAxis range={[80, 80]} />
            <Tooltip
              cursor={{ strokeDasharray: '3 3' }}
              content={({ payload }) => {
                const p = payload?.[0]?.payload as
                  | { label: string; x: number; y: number; kind: string }
                  | undefined;
                if (!p) return null;
                return (
                  <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs shadow-sm">
                    <div className="font-semibold text-slate-900">{p.label}</div>
                    <div className="text-slate-600">
                      Cost {p.x.toFixed(1)}% · Quality {p.y.toFixed(1)}%
                      {p.kind === 'router' ? ' · router' : ''}
                    </div>
                  </div>
                );
              }}
            />
            {data.map((d) => (
              <Scatter
                key={d.id}
                name={d.label}
                data={[d]}
                fill={d.fill}
                shape={d.kind === 'router' ? 'diamond' : 'circle'}
              />
            ))}
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-600">
        {result.targets.map((t, i) => (
          <li key={t.targetId} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block size-2.5 rounded-full"
              style={{
                background: pointColor(i, t.kind),
                borderRadius: t.kind === 'router' ? 0 : 999,
                transform: t.kind === 'router' ? 'rotate(45deg)' : undefined,
              }}
            />
            {t.label}
            <span className="text-slate-400">
              ({pct(t.quality, 0)} · {t.relativeCostPct.toFixed(0)}% cost)
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
