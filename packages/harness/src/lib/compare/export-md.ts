import { assertNoCurrency } from './assert-no-currency';
import type { CompareResult } from './types';

export function compareResultToMarkdown(result: CompareResult): string {
  const lines: string[] = [];
  lines.push(`# Model comparison`);
  lines.push('');
  lines.push(`- Baseline: \`${result.baselineModelId}\` (relative cost = 100%)`);
  lines.push(`- Quality axis: ${result.qualityAxisLabel}`);
  lines.push(`- Token profile: ${result.tokenProfile.label}`);
  lines.push(
    `  - uncached in ${result.tokenProfile.uncachedInputTokens}, cached in ${result.tokenProfile.cachedInputTokens}, out ${result.tokenProfile.outputTokens}, parallel ${result.tokenProfile.parallelSections}, failureRate ${result.tokenProfile.failureRate}`,
  );
  lines.push(
    `- Weights: quality ${result.weights.quality}, preference ${result.weights.preference}, cost ${result.weights.cost}, speed ${result.weights.speed}`,
  );
  lines.push(`- Good-enough latency ceiling: ${result.goodEnoughSeconds}s (arbitrary default if unchanged)`);
  if (result.correlation.rSquared != null) {
    lines.push(
      `- Quality↔preference r²: ${result.correlation.rSquared.toFixed(3)} (r=${result.correlation.pearsonR?.toFixed(3)})`,
    );
  } else {
    lines.push(`- Quality↔preference correlation: ${result.correlation.feedback}`);
  }
  lines.push('');
  lines.push(
    `| Rank | Model | Composite | Rel. cost % | Quality | Preference | Speed | Swing | Frontier | Missing |`,
  );
  lines.push(`| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | :---: | --- |`);
  for (const r of result.ranked) {
    const fmt = (n: number | null) => (n == null ? '—' : n.toFixed(1));
    lines.push(
      `| ${r.rank} | ${r.label} (\`${r.modelId}\`) | ${fmt(r.composite.score)} | ${fmt(r.axes.relativeCostPct)}${r.axes.cost.upperBound ? '†' : ''} | ${fmt(r.axes.quality.score)} | ${fmt(r.axes.preference.score)} | ${fmt(r.axes.speed.score)} | ${r.rankSwing} | ${r.onParetoFrontier ? 'yes' : ''} | ${r.missingAxes.join(',') || '—'} |`,
    );
  }
  lines.push('');
  lines.push('† Upper-bound cost: published cache input rate missing; full input rate used.');
  lines.push('');
  lines.push(
    'Cost is always % of baseline — never absolute currency. Rows missing axes are renormalized and not directly comparable to full-axis rows.',
  );
  if (result.notes.length) {
    lines.push('');
    lines.push('## Notes');
    for (const n of result.notes) lines.push(`- ${n}`);
  }
  const md = lines.join('\n') + '\n';
  assertNoCurrency(md, 'compare markdown export');
  return md;
}
