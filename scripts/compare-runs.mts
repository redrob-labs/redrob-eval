/**
 * Is that difference real?
 *
 * Two accuracy numbers side by side invite exactly one question, and a point
 * estimate cannot answer it. This reads the per-item outcomes a run stored and
 * reports, for every pair of models: each rate with a Wilson interval, the
 * paired difference with a bootstrap interval, McNemar's exact p, the same p
 * adjusted for how many pairs were tested, and a warning when the comparison is
 * too small to carry a claim.
 *
 *   yarn compare-runs --run <id>
 *   yarn compare-runs --run <id> --metric absence
 *   yarn compare-runs --run <id> --metric parsed --json out.json
 */
import { writeFileSync } from 'node:fs';

import { compareModels, createRunStore } from '@redrob/harness';
import type { ToolRoutingMetric, ToolRoutingReport } from '@redrob/harness';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

const runId = arg('run');
if (!runId) {
  console.error('Usage: yarn compare-runs --run <run id> [--metric toolSelect|argExact|absence|parsed]');
  process.exit(2);
}
const metric = (arg('metric') ?? 'toolSelect') as ToolRoutingMetric;

const store = await createRunStore();
try {
  const run = await store.get(runId);
  if (!run) {
    console.error(`No run with id ${runId}`);
    process.exit(1);
  }

  // One report per model. A matrix stores a report per cell, so several cells of
  // the same model are merged: the comparison is per model, over items.
  const merged = new Map<string, ToolRoutingReport>();
  for (const name of await store.listArtifacts(runId)) {
    const artifact = await store.readArtifact(runId, name);
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) continue;
    const report = artifact as unknown as ToolRoutingReport;
    if (report.schema !== 'redrob-tool-routing/v2') continue;
    const existing = merged.get(report.modelId);
    if (existing) {
      existing.examples = [...(existing.examples ?? []), ...(report.examples ?? [])];
    } else {
      merged.set(report.modelId, { ...report, examples: [...(report.examples ?? [])] });
    }
  }

  if (merged.size < 2) {
    console.error(
      `Need at least two models with stored reports; found ${merged.size}. ` +
        'Run a matrix over several models first.',
    );
    process.exit(1);
  }

  const result = compareModels({
    reports: [...merged.entries()].map(([model, report]) => ({ model, report })),
    metric,
  });

  const pc = (v: number) => `${(v * 100).toFixed(0)}%`;
  console.log(`run ${runId} · metric ${metric}`);
  console.log('');
  console.log('| model | rate | 95% interval | n |');
  console.log('| --- | --- | --- | --- |');
  for (const r of [...result.rates].sort((x, y) => y.rate - x.rate)) {
    console.log(
      `| ${r.model} | ${pc(r.rate)} | ${pc(r.interval.low)}–${pc(r.interval.high)} | ${r.n} |`,
    );
  }

  console.log('');
  console.log('| pair | difference | 95% interval | disagreed | p | p (adjusted) |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  for (const pair of result.pairs) {
    const d = pair.diff;
    const sign = d.value >= 0 ? '+' : '';
    const discordant = pair.mcnemar.aOnly + pair.mcnemar.bOnly;
    console.log(
      `| ${pair.a.model} vs ${pair.b.model} | ${sign}${pc(d.value)} | ` +
        `${pc(d.interval.low)}–${pc(d.interval.high)} | ${discordant} | ` +
        `${pair.mcnemar.p.toFixed(3)} | ${pair.adjustedP.toFixed(3)} |`,
    );
  }

  // The interpretation, spelled out. A table of p values invites the reader to
  // eyeball 0.05, and the adjusted column is the one that counts.
  const separated = result.pairs.filter((p) => p.adjustedP < 0.05);
  console.log('');
  if (separated.length === 0) {
    console.log(
      'No pair is separated at the 5% level after adjusting for multiple comparisons.',
    );
    console.log('On these denominators that is the expected outcome for small differences.');
  } else {
    console.log(`${separated.length} pair(s) separated at the 5% level (adjusted):`);
    for (const p of separated) {
      const better = p.diff.value > 0 ? p.a.model : p.b.model;
      console.log(`  ${better} is ahead: ${p.a.model} vs ${p.b.model}, p=${p.adjustedP.toFixed(3)}`);
    }
  }

  const warned = result.pairs.filter((p) => p.warnings.length > 0);
  if (warned.length) {
    console.log('');
    for (const p of warned) {
      console.log(`! ${p.a.model} vs ${p.b.model}: ${p.warnings.join('; ')}`);
    }
  }

  const out = arg('json');
  if (out) {
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.error(`wrote ${out}`);
  }
} finally {
  await store.close();
}
