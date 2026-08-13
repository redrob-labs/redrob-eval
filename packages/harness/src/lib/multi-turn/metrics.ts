import type {
  CapabilitySlice,
  DepthSlice,
  MultiTurnCapability,
  MultiTurnLanguage,
  MultiTurnReport,
  ScenarioRecord,
} from './types';

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index]!;
}

function rate(passed: number, total: number): number {
  return total > 0 ? passed / total : 0;
}

/**
 * Roll transcripts into rates.
 *
 * Two cuts, because the headline number hides both things worth knowing. By
 * capability separates a forgotten constraint from a bungled tool call. By
 * depth answers the question multi-turn exists to ask: does this model hold up
 * at turn four, or only at turn one.
 */
export function buildMultiTurnReport(params: {
  modelId: string;
  languages: MultiTurnLanguage[];
  scenarios: ScenarioRecord[];
}): MultiTurnReport {
  const turns = params.scenarios.flatMap((s) => s.turns);

  const byCapabilityMap = new Map<MultiTurnCapability, { turns: number; passed: number }>();
  const byDepthMap = new Map<number, { turns: number; passed: number }>();
  for (const turn of turns) {
    const cap = byCapabilityMap.get(turn.capability) ?? { turns: 0, passed: 0 };
    cap.turns += 1;
    if (turn.passed) cap.passed += 1;
    byCapabilityMap.set(turn.capability, cap);

    const depth = byDepthMap.get(turn.index) ?? { turns: 0, passed: 0 };
    depth.turns += 1;
    if (turn.passed) depth.passed += 1;
    byDepthMap.set(turn.index, depth);
  }

  const byCapability: CapabilitySlice[] = [...byCapabilityMap.entries()]
    .map(([capability, v]) => ({
      capability,
      turns: v.turns,
      passed: v.passed,
      passRate: rate(v.passed, v.turns),
    }))
    .sort((a, b) => a.capability.localeCompare(b.capability));

  const byDepth: DepthSlice[] = [...byDepthMap.entries()]
    .map(([turn, v]) => ({
      turn,
      turns: v.turns,
      passed: v.passed,
      passRate: rate(v.passed, v.turns),
    }))
    .sort((a, b) => a.turn - b.turn);

  const latencies = turns
    .map((t) => t.latencyMs)
    .filter((ms): ms is number => typeof ms === 'number');
  const scenariosPassed = params.scenarios.filter((s) => s.passed).length;
  const turnsPassed = turns.filter((t) => t.passed).length;

  return {
    schema: 'redrob-multi-turn/v1',
    createdAt: new Date().toISOString(),
    modelId: params.modelId,
    languages: params.languages,
    scenarios: params.scenarios,
    scenariosPassed,
    scenarioPassRate: rate(scenariosPassed, params.scenarios.length),
    turnsPassed,
    turnPassRate: rate(turnsPassed, turns.length),
    byCapability,
    byDepth,
    callErrors: turns.filter((t) => t.error).length,
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
  };
}
