/**
 * Run a tool-routing grid as one resumable job.
 *
 * `tool-routing:live` runs models one after another and forgets everything if
 * it dies. This runs the same work as a matrix - one cell per (model, language)
 * - checkpointed to the registry, so a sweep that is interrupted can be resumed
 * to run only the cells it did not finish.
 *
 *   yarn tool-routing:matrix --models a,b,c --languages en,ko --limit 20
 *   yarn tool-routing:matrix --resume 2026-08-13_021500_tool-routing-matrix
 *   yarn tool-routing:matrix --models a,b --concurrency 2
 *
 * Interrupt with Ctrl-C; the line it prints is the resume command.
 * Needs the provider key in the repo-root `.env` (or the environment).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createRunStore,
  readMatrixCells,
  runRegistryMatrix,
  runToolRoutingHarness,
} from '@redrob/harness';
import type { RunJson as Json, ProviderId, ToolRoutingLanguage } from '@redrob/harness';
import { stubTasksForLanguage } from '../packages/harness/src/lib/tool-routing/fixtures.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv(): void {
  let raw: string;
  try {
    raw = readFileSync(path.join(REPO_ROOT, '.env'), 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const value = m[2]!.trim().replace(/^["']|["']$/g, '');
    if (value && !process.env[m[1]!]) process.env[m[1]!] = value;
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function pct(v: number | null | undefined): string {
  return v == null ? '—' : `${(v * 100).toFixed(0)}%`;
}
function sample<T>(items: T[], take: number): T[] {
  if (take <= 0 || take >= items.length) return items;
  const step = items.length / take;
  return Array.from({ length: take }, (_, i) => items[Math.floor(i * step)]!);
}

loadDotEnv();

const concurrency = Number(arg('concurrency') ?? '2') || 2;
const resume = arg('resume');

const store = await createRunStore();

// On resume everything that defines the grid comes from the run being reopened,
// so the flags do not have to be repeated - the run remembers what it was, and
// repeating them wrongly would trip the glue's "parameters differ" guard.
let models: string[];
let languages: ToolRoutingLanguage[];
let provider: ProviderId;
let limit: number;
if (resume) {
  const run = await store.get(resume);
  if (!run) {
    console.error(`No run with id ${resume}`);
    await store.close();
    process.exit(1);
  }
  const p = run.params as {
    dimensions?: { model?: string[]; language?: string[] };
    provider?: string;
    limit?: number;
  };
  models = p.dimensions?.model ?? [];
  languages = (p.dimensions?.language ?? []) as ToolRoutingLanguage[];
  provider = (p.provider ?? 'openrouter') as ProviderId;
  limit = p.limit ?? 0;
  console.error(`Resuming ${resume}: ${models.length} model(s) x ${languages.length} language(s)`);
} else {
  models = (arg('models') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  languages = (arg('languages') ?? 'en,hi,hi-Latn,ko')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as ToolRoutingLanguage[];
  provider = (arg('provider') ?? 'openrouter') as ProviderId;
  limit = Number(arg('limit') ?? '0') || 0;
  if (models.length === 0) {
    console.error('Provide --models a,b,c (or --resume <runId>).');
    await store.close();
    process.exit(2);
  }
}

const controller = new AbortController();
let interrupted = false;
process.on('SIGINT', () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  console.error('\nInterrupting after the cells in flight finish…');
  controller.abort();
});

const { runId, result } = await runRegistryMatrix({
  store,
  kind: 'tool-routing-matrix',
  label: `${models.length} models x ${languages.length} langs`,
  tags: ['tool-routing', 'matrix'],
  models,
  datasetId: 'tool-routing-fixtures',
  dimensions: { model: models as Json[], language: languages as Json[] },
  extraParams: { provider, limit },
  concurrency,
  maxAttempts: 2,
  signal: controller.signal,
  ...(resume ? { resume } : {}),
  onProgress: (p) => {
    if (p.cell) {
      const mark = p.cell.status === 'done' ? 'ok' : 'FAIL';
      process.stderr.write(
        `\r[${p.done + p.failed}/${p.total}] ${mark} ${p.cell.key}` + ' '.repeat(12) + '\n',
      );
    }
  },
  async worker(cell, { signal, runId }) {
    const { model, language } = cell.params as { model: string; language: ToolRoutingLanguage };
    const tasks = sample(stubTasksForLanguage(language), limit);
    const report = await runToolRoutingHarness({
      modelId: model,
      servedModelId: model,
      providerId: provider,
      tasks,
      languages: [language],
      conditions: ['contract'],
    });
    if (signal.aborted) throw new Error('aborted');
    // The full report, every prompt and reply, kept beside the run. The cell
    // summary carries the rates; this is the evidence behind them, and what
    // `yarn failures` reads to say which items failed and why.
    await store.putArtifact(runId, `cell-${cell.key}`, report as unknown as Json);
    const slice = report.slices[0]!;
    return {
      model,
      language,
      n: slice.n,
      toolSelect: slice.toolSelectAccuracy,
      argExact: slice.argExactMatchAccuracy,
      absence: slice.absenceAccuracy,
      parseFail: slice.parseFailureRate,
    } as Json;
  },
});

// Rebuild the table from the registry, so it is the same whether this was one
// pass or a resume: the cells that finished earlier are read back, not lost.
const cells = await readMatrixCells(store, runId);
const byModel = new Map<string, Map<string, Json>>();
for (const cell of cells) {
  const s = cell.summary as { model?: string; language?: string } | undefined;
  if (!s?.model || !s.language) continue;
  if (!byModel.has(s.model)) byModel.set(s.model, new Map());
  byModel.get(s.model)!.set(s.language, cell.summary!);
}

console.log('');
console.log(`run ${runId} · ${result.done}/${result.done + result.failed + (result.cancelled ? 1 : 0)} cell(s) done${result.cancelled ? ' · cancelled' : ''}`);
console.log('');
console.log(`| model | ${languages.map((l) => `${l} tool`).join(' | ')} |`);
console.log(`| --- | ${languages.map(() => '---').join(' | ')} |`);
for (const model of models) {
  const row = byModel.get(model);
  const cellsFor = languages.map((lang) => {
    const s = row?.get(lang) as { toolSelect?: number | null } | undefined;
    return s ? pct(s.toolSelect) : '·';
  });
  console.log(`| ${model} | ${cellsFor.join(' | ')} |`);
}

if (result.cancelled) {
  console.error(`\nResume with:\n  yarn tool-routing:matrix --resume ${runId}`);
}
await store.close();
