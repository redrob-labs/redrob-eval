/**
 * Baseline vs evolved comparison + exportable report (relative cost only).
 */
import type { Candidate, EvalBatch, FrontierPoint } from '../optimizer/types';

export interface CandidateSnapshot {
  candidate: Candidate;
  val: EvalBatch | null;
  test: EvalBatch | null;
}

export interface OptimizeReport {
  schemaVersion: 1;
  runId: string;
  createdAt: string;
  qualityFloor: number;
  datasetId: string;
  optimizer: string;
  baseline: CandidateSnapshot;
  evolved: CandidateSnapshot;
  /** Relative cost of evolved vs baseline (100 = same weight). Never currency. */
  relativeCostPct: number | null;
  tokenDelta: number | null;
  qualityDeltaVal: number | null;
  qualityDeltaTest: number | null;
  demos: {
    baselineRequested: number;
    baselineFitted: number;
    evolvedRequested: number;
    evolvedFitted: number;
  };
  /** Same shape as demos — for frame_policy / video checklist runs */
  frames: {
    baselineRequested: number;
    baselineFitted: number;
    evolvedRequested: number;
    evolvedFitted: number;
  };
  frontier: FrontierPoint[];
  notes: string[];
}

function relativeCostPct(
  evolved: EvalBatch | null,
  baseline: EvalBatch | null,
): number | null {
  if (!evolved || !baseline) return null;
  const b = baseline.meanRelativeCost;
  if (!b || b <= 0) return null;
  return (evolved.meanRelativeCost / b) * 100;
}

export function buildOptimizeReport(params: {
  runId: string;
  createdAt?: string;
  qualityFloor: number;
  datasetId: string;
  optimizer: string;
  baseline: Candidate;
  baselineVal: EvalBatch | null;
  baselineTest?: EvalBatch | null;
  evolved: Candidate | null;
  evolvedVal: EvalBatch | null;
  evolvedTest?: EvalBatch | null;
  frontier: FrontierPoint[];
}): OptimizeReport {
  const evolvedCand = params.evolved ?? params.baseline;
  const evolvedVal = params.evolvedVal ?? params.baselineVal;
  const notes: string[] = [];
  if (!params.evolved) {
    notes.push('No improved candidate; baseline is reported as evolved.');
  }
  if (evolvedVal && !evolvedVal.tokensMeasured) {
    notes.push('Some token counts were estimated (tokenizer unavailable).');
  }
  if (evolvedVal?.abstentionRate != null && evolvedVal.abstentionRate > 0) {
    notes.push(
      `Abstention rate (val): ${(evolvedVal.abstentionRate * 100).toFixed(1)}%, excluded from QWK.`,
    );
  }

  const bReq = params.baselineVal?.demosRequested ?? params.baseline.demosRequested ?? params.baseline.demos.length;
  const bFit = params.baselineVal?.demosFitted ?? params.baseline.demos.length;
  const eReq = evolvedVal?.demosRequested ?? evolvedCand.demosRequested ?? evolvedCand.demos.length;
  const eFit = evolvedVal?.demosFitted ?? evolvedCand.demos.length;

  const bfReq =
    params.baselineVal?.framesRequested ??
    params.baseline.framesRequested ??
    params.baseline.framePolicy?.n_frames ??
    0;
  const bfFit = params.baselineVal?.framesFitted ?? bfReq;
  const efReq =
    evolvedVal?.framesRequested ??
    evolvedCand.framesRequested ??
    evolvedCand.framePolicy?.n_frames ??
    0;
  const efFit = evolvedVal?.framesFitted ?? efReq;

  return {
    schemaVersion: 1,
    runId: params.runId,
    createdAt: params.createdAt ?? new Date().toISOString(),
    qualityFloor: params.qualityFloor,
    datasetId: params.datasetId,
    optimizer: params.optimizer,
    baseline: {
      candidate: params.baseline,
      val: params.baselineVal,
      test: params.baselineTest ?? null,
    },
    evolved: {
      candidate: evolvedCand,
      val: evolvedVal,
      test: params.evolvedTest ?? null,
    },
    relativeCostPct: relativeCostPct(evolvedVal, params.baselineVal),
    tokenDelta:
      evolvedVal && params.baselineVal
        ? evolvedVal.totalTokens - params.baselineVal.totalTokens
        : null,
    qualityDeltaVal:
      evolvedVal && params.baselineVal
        ? evolvedVal.quality - params.baselineVal.quality
        : null,
    qualityDeltaTest:
      params.evolvedTest && params.baselineTest
        ? params.evolvedTest.quality - params.baselineTest.quality
        : null,
    demos: {
      baselineRequested: bReq,
      baselineFitted: bFit,
      evolvedRequested: eReq,
      evolvedFitted: eFit,
    },
    frames: {
      baselineRequested: bfReq,
      baselineFitted: bfFit,
      evolvedRequested: efReq,
      evolvedFitted: efFit,
    },
    frontier: params.frontier,
    notes,
  };
}

/** Markdown export — relative percentages only, no currency. */
export function reportToMarkdown(report: OptimizeReport): string {
  const b = report.baseline;
  const e = report.evolved;
  const lines = [
    `# Optimize report: ${report.runId}`,
    '',
    `- Dataset: ${report.datasetId}`,
    `- Optimizer: ${report.optimizer}`,
    `- Quality floor: ${report.qualityFloor}`,
    `- Created: ${report.createdAt}`,
    '',
    '## Baseline',
    `- Model: ${b.candidate.model.modelId}`,
    `- Script: ${JSON.stringify(b.candidate.scriptPolicies ?? b.candidate.scriptPolicy)}`,
    `- Frame: ${JSON.stringify(b.candidate.framePolicy ?? null)}`,
    `- Demos requested/fitted: ${report.demos.baselineRequested}/${report.demos.baselineFitted}`,
    `- Frames requested/fitted: ${report.frames.baselineRequested}/${report.frames.baselineFitted}`,
    `- Val quality: ${b.val ? b.val.quality.toFixed(4) : '—'}`,
    `- Val tokens: ${b.val ? b.val.totalTokens : '—'}`,
    `- Instruction:`,
    '```',
    b.candidate.instruction,
    '```',
    '',
    '## Evolved',
    `- Model: ${e.candidate.model.modelId}`,
    `- Script: ${JSON.stringify(e.candidate.scriptPolicies ?? e.candidate.scriptPolicy)}`,
    `- Frame: ${JSON.stringify(e.candidate.framePolicy ?? null)}`,
    `- Demos requested/fitted: ${report.demos.evolvedRequested}/${report.demos.evolvedFitted}`,
    `- Frames requested/fitted: ${report.frames.evolvedRequested}/${report.frames.evolvedFitted}`,
    `- Val quality: ${e.val ? e.val.quality.toFixed(4) : '—'}`,
    `- Val tokens: ${e.val ? e.val.totalTokens : '—'}`,
    `- Instruction:`,
    '```',
    e.candidate.instruction,
    '```',
    '',
    '## Delta (relative)',
    `- Token Δ (val): ${report.tokenDelta ?? '—'}`,
    `- Quality Δ (val): ${report.qualityDeltaVal != null ? report.qualityDeltaVal.toFixed(4) : '—'}`,
    `- Relative cost vs baseline: ${
      report.relativeCostPct != null ? `${report.relativeCostPct.toFixed(1)}%` : '—'
    }`,
    '',
  ];
  if (report.notes.length) {
    lines.push('## Notes', ...report.notes.map((n) => `- ${n}`), '');
  }
  return lines.join('\n');
}
