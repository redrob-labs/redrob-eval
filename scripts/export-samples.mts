/**
 * Write reproducible sample artifacts under exports/samples/ (offline, no provider calls).
 * Run: yarn export:samples
 *
 * These use the same buildOptimizeReport / reportToMarkdown path as live Evolve exports,
 * with deterministic fixture batches so CI and clones can regenerate identical files.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildOptimizeReport,
  defaultScriptBundle,
  reportToMarkdown,
  seedCandidate,
  type EvalBatch,
  type FrontierPoint,
} from '../packages/harness/src/index';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'exports', 'samples');

function batch(
  quality: number,
  tokens: number,
  demosReq: number,
  demosFit: number,
  meanRelativeCost: number,
): EvalBatch {
  return {
    quality,
    meanRelativeCost,
    promptTokens: Math.floor(tokens / 2),
    completionTokens: Math.ceil(tokens / 2),
    totalTokens: tokens,
    latencyP50: 100,
    demosRequested: demosReq,
    demosFitted: demosFit,
    outcomes: [{ exampleId: 'e0', score: quality, feedback: 'ok' }],
  };
}

function paretoSvg(points: { id: string; x: number; y: number; fill: string }[]): string {
  const W = 640;
  const H = 360;
  const pad = { l: 56, r: 24, t: 28, b: 48 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const xMin = 0;
  const xMax = 100;
  const yMin = 0.4;
  const yMax = 0.85;
  const sx = (x: number) => pad.l + ((x - xMin) / (xMax - xMin)) * plotW;
  const sy = (y: number) => pad.t + (1 - (y - yMin) / (yMax - yMin)) * plotH;
  const floorY = 0.5;
  const dots = points
    .map(
      (p) =>
        `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="7" fill="${p.fill}" />` +
        `<text x="${(sx(p.x) + 10).toFixed(1)}" y="${(sy(p.y) + 4).toFixed(1)}" font-size="12" fill="#222">${p.id}</text>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Baseline vs evolved Pareto (relative cost vs val quality)">
  <rect width="${W}" height="${H}" fill="#f3f4f1"/>
  <text x="${W / 2}" y="18" text-anchor="middle" font-family="ui-sans-serif,system-ui,sans-serif" font-size="14" fill="#0c0e10">Evolve sample: relative cost % vs val quality</text>
  <line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t + plotH}" stroke="#9aa19a" stroke-width="1"/>
  <line x1="${pad.l}" y1="${pad.t + plotH}" x2="${pad.l + plotW}" y2="${pad.t + plotH}" stroke="#9aa19a" stroke-width="1"/>
  <line x1="${pad.l}" y1="${sy(floorY).toFixed(1)}" x2="${pad.l + plotW}" y2="${sy(floorY).toFixed(1)}" stroke="#1633c9" stroke-width="1.5" stroke-dasharray="6 4"/>
  <text x="${pad.l + plotW - 4}" y="${(sy(floorY) - 6).toFixed(1)}" text-anchor="end" font-size="11" fill="#1633c9">quality floor 0.50</text>
  ${dots}
  <text x="${pad.l + plotW / 2}" y="${H - 14}" text-anchor="middle" font-size="12" fill="#555">Relative cost % of baseline (lower is cheaper)</text>
  <text x="16" y="${pad.t + plotH / 2}" text-anchor="middle" font-size="12" fill="#555" transform="rotate(-90 16 ${pad.t + plotH / 2})">Val quality</text>
</svg>
`;
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });

  const baseline = seedCandidate({
    instruction: 'Translate carefully.',
    demos: [
      { input: 'एक', output: 'one' },
      { input: 'दो', output: 'two' },
      { input: 'तीन', output: 'three' },
    ],
    model: { modelId: 'test/model', providerId: 'openrouter', relativeCostWeight: 40 },
    scriptPolicies: defaultScriptBundle('romanize'),
    maxPromptTokens: 80,
    demosRequested: 3,
  });
  const evolved = {
    ...baseline,
    id: 'evolved_1',
    instruction: 'Improved instruction for Indic translation under a token budget.',
    model: { ...baseline.model, relativeCostWeight: 25 },
  };

  const baselineVal = batch(0.6, 200, 3, 2, 40);
  const evolvedVal = batch(0.7, 120, 3, 3, 25);
  const frontier: FrontierPoint[] = [
    {
      candidateId: baseline.id,
      quality: baselineVal.quality,
      meanRelativeCost: baselineVal.meanRelativeCost,
      totalTokens: baselineVal.totalTokens,
      feasible: baselineVal.quality >= 0.5,
    },
    {
      candidateId: evolved.id,
      quality: evolvedVal.quality,
      meanRelativeCost: evolvedVal.meanRelativeCost,
      totalTokens: evolvedVal.totalTokens,
      feasible: evolvedVal.quality >= 0.5,
    },
  ];

  const report = buildOptimizeReport({
    runId: 'sample_offline_in22-hi-en',
    createdAt: '2026-07-31T00:00:00.000Z',
    qualityFloor: 0.5,
    datasetId: 'in22-gen-hi-en',
    optimizer: 'gepa',
    baseline,
    baselineVal,
    evolved,
    evolvedVal,
    frontier,
  });

  const md = reportToMarkdown(report);
  const svg = paretoSvg([
    { id: 'baseline', x: 100, y: baselineVal.quality, fill: '#6b7280' },
    {
      id: 'evolved',
      x: report.relativeCostPct ?? 62.5,
      y: evolvedVal.quality,
      fill: '#1633c9',
    },
  ]);

  await writeFile(path.join(outDir, 'optimize-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(path.join(outDir, 'optimize-report.md'), `${md}\n`, 'utf8');
  await writeFile(path.join(outDir, 'pareto.svg'), svg, 'utf8');

  const readme = `# Sample exports

Reproducible offline artifacts (no provider keys). Regenerate with:

\`\`\`bash
yarn export:samples
\`\`\`

| File | What it is |
|------|------------|
| \`optimize-report.md\` / \`.json\` | Baseline vs evolved report from \`buildOptimizeReport\` / \`reportToMarkdown\` (same path as Evolve UI export) |
| \`pareto.svg\` | Relative cost % vs val quality for the sample baseline and evolved points |

## Text-mode routing finding (not in these files)

Hand-written length/keyword heuristics agreed with dual-eval oracle labels only about **25%** of the time on some GSM8K slices. That measurement used live dual-eval runs (see \`docs/learnings.md\`, 2026-07-27). Full routing corpora stay local under \`eval/routing-runs/\` (gitignored) because they are generated against provider APIs; the Evolve sample above is the committed, regenerable harness evidence.
`;
  await writeFile(path.join(outDir, 'README.md'), readme, 'utf8');

  console.log(`Wrote samples to ${outDir}`);
  console.log(`relativeCostPct=${report.relativeCostPct?.toFixed(1)} tokenDelta=${report.tokenDelta}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
