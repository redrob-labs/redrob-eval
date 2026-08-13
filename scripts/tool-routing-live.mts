/**
 * Run the tool-routing set against real models and print a comparison table.
 *
 * The offline gate (`yarn verify:tool-routing`) proves the fixtures and the
 * scoring. This spends tokens to find out how models actually do, which is the
 * part a paper reports.
 *
 *   yarn tool-routing:live --models liquid/lfm-2.5-2.6b:free,ibm-granite/granite-4.1-8b
 *   yarn tool-routing:live --models qwen/qwen3.5-9b --languages en,ko --limit 40
 *   yarn tool-routing:live --models ... --provider vllm --json out.json
 *
 * Needs the provider key in the repo-root `.env` (or the environment).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runToolRoutingHarness } from '@redrob/harness';
import type { ProviderId, ToolRoutingLanguage, ToolRoutingReport } from '@redrob/harness';
import { stubTasksForLanguage } from '../packages/harness/src/lib/tool-routing/fixtures.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The web app reads `.env` through Next; a bare script has to do it itself. */
function loadDotEnv(): void {
  let raw: string;
  try {
    raw = readFileSync(path.join(REPO_ROOT, '.env'), 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1]!;
    const value = match[2]!.trim().replace(/^["']|["']$/g, '');
    if (value && !process.env[key]) process.env[key] = value;
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function pct(v: number | null): string {
  return v == null ? '—' : `${(v * 100).toFixed(0)}%`;
}

loadDotEnv();

const models = (arg('models') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (models.length === 0) {
  console.error('Provide --models a,b,c (ids the provider expects).');
  process.exit(2);
}
const providerId = (arg('provider') ?? 'openrouter') as ProviderId;
const languages = (arg('languages') ?? 'en,hi,hi-Latn,ko')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean) as ToolRoutingLanguage[];
/** Tasks per language. The full set is 81 each, which is a lot of tokens. */
const limit = Number(arg('limit') ?? '0') || 0;

/**
 * Take a subset by even stride rather than by prefix.
 *
 * The fixture file is ordered by scenario, so the first N tasks of a language
 * are not a sample of it - they are its first few scenarios, and the absence
 * cases are not spread evenly through them. A prefix run reported an absence
 * rate over five items, which is the small-denominator problem this dataset
 * was enlarged to escape. A stride keeps the mix of calls, absences and
 * toolsets close to the full set's, and it is deterministic.
 */
function sample<T>(items: T[], take: number): T[] {
  if (take <= 0 || take >= items.length) return items;
  const step = items.length / take;
  return Array.from({ length: take }, (_, i) => items[Math.floor(i * step)]!);
}

const tasks = languages.flatMap((lang) => sample(stubTasksForLanguage(lang), limit));
console.error(
  `${tasks.length} tasks (${languages.join(', ')}) x ${models.length} model(s), contract only`,
);

const reports: Array<{ model: string; report: ToolRoutingReport | null; error?: string }> = [];

for (const modelId of models) {
  const started = Date.now();
  try {
    const report = await runToolRoutingHarness({
      modelId,
      servedModelId: modelId,
      providerId,
      tasks,
      languages,
      conditions: ['contract'],
      onProgress: ({ done, total }) => {
        if (done % 25 === 0 || done === total) {
          process.stderr.write(`\r  ${modelId}: ${done}/${total}   `);
        }
      },
    });
    process.stderr.write('\n');
    reports.push({ model: modelId, report });
    console.error(`  done in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  } catch (e) {
    process.stderr.write('\n');
    const message = e instanceof Error ? e.message : String(e);
    reports.push({ model: modelId, report: null, error: message });
    console.error(`  ${modelId} failed: ${message}`);
  }
}

/** One row per model, averaged over the languages that were run. */
function overall(report: ToolRoutingReport) {
  let toolHit = 0, toolN = 0, argHit = 0, argN = 0, absHit = 0, absN = 0, parse = 0, n = 0;
  let envelopeErrors = 0;
  for (const s of report.slices) {
    n += s.n;
    parse += s.parseFailureRate * s.n;
    toolN += s.denominators.toolSelect;
    toolHit += (s.toolSelectAccuracy ?? 0) * s.denominators.toolSelect;
    argN += s.denominators.argExactMatch;
    argHit += (s.argExactMatchAccuracy ?? 0) * s.denominators.argExactMatch;
    absN += s.denominators.absence;
    absHit += (s.absenceAccuracy ?? 0) * s.denominators.absence;
    envelopeErrors += s.envelope?.errors ?? 0;
  }
  return {
    n,
    toolN,
    argN,
    absN,
    toolSelect: toolN ? toolHit / toolN : null,
    argExact: argN ? argHit / argN : null,
    absence: absN ? absHit / absN : null,
    parseFail: n ? parse / n : 0,
    envelopeErrors,
  };
}

// Denominators are printed next to every rate. Each metric skips the examples
// it does not apply to, and a rate over five items is not a result.
console.log('');
console.log('| model | n | tool select | args exact | absence | parse fail | envelope |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const r of reports) {
  if (!r.report) {
    console.log(`| ${r.model} | — | — | — | — | — | ${r.error ?? 'failed'} |`);
    continue;
  }
  const o = overall(r.report);
  console.log(
    `| ${r.model} | ${o.n} | ${pct(o.toolSelect)} (${o.toolN}) | ${pct(o.argExact)} (${o.argN}) | ` +
      `${pct(o.absence)} (${o.absN}) | ${pct(o.parseFail)} | ${o.envelopeErrors} |`,
  );
}

// Per-language, because the whole point of the language axis is that it moves.
if (languages.length > 1) {
  console.log('');
  console.log(`| model | ${languages.map((l) => `${l} tool`).join(' | ')} |`);
  console.log(`| --- | ${languages.map(() => '---').join(' | ')} |`);
  for (const r of reports) {
    if (!r.report) continue;
    const cells = languages.map((lang) => {
      const s = r.report!.slices.find((x) => x.language === lang);
      return pct(s?.toolSelectAccuracy ?? null);
    });
    console.log(`| ${r.model} | ${cells.join(' | ')} |`);
  }
}

const out = arg('json');
if (out) {
  writeFileSync(out, `${JSON.stringify(reports, null, 2)}\n`, 'utf8');
  console.error(`wrote ${out}`);
}
