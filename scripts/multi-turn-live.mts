/**
 * Run the multi-turn scenarios against a real model and print what happened.
 *
 * This is the live counterpart to `yarn verify:multi-turn`, which scripts the
 * model side and proves the harness. Here the model actually answers, so the
 * output is about the model: which capability it drops first, and at what depth.
 *
 *   yarn multi-turn:live --provider openrouter --model openai/gpt-4o-mini
 *   yarn multi-turn:live --provider vllm --model redrob-s0 --languages ko
 *
 * Needs the provider's key in the repo-root `.env` (or the environment).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  multiTurnScenariosFor,
  runMultiTurnHarness,
  type MultiTurnLanguage,
  type MultiTurnReport,
} from '@redrob/harness';
import type { ProviderId } from '@redrob/harness';

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

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function printReport(report: MultiTurnReport): void {
  console.log('');
  console.log(`# multi-turn · ${report.modelId}`);
  console.log(
    `scenarios ${report.scenariosPassed}/${report.scenarios.length} (${pct(
      report.scenarioPassRate,
    )}) · turns ${report.turnsPassed}/${report.scenarios.reduce(
      (n, s) => n + s.turns.length,
      0,
    )} (${pct(report.turnPassRate)}) · call errors ${report.callErrors} · p50 ${
      report.latencyMs.p50 ?? '-'
    } ms`,
  );

  console.log('');
  console.log('| capability | turns | pass |');
  console.log('| --- | --- | --- |');
  for (const slice of report.byCapability) {
    console.log(`| ${slice.capability} | ${slice.turns} | ${pct(slice.passRate)} |`);
  }

  console.log('');
  console.log('| turn depth | turns | pass |');
  console.log('| --- | --- | --- |');
  for (const slice of report.byDepth) {
    console.log(`| ${slice.turn} | ${slice.turns} | ${pct(slice.passRate)} |`);
  }

  const failures = report.scenarios.flatMap((s) =>
    s.turns.filter((t) => !t.passed).map((t) => ({ scenario: s.scenarioId, turn: t })),
  );
  if (failures.length === 0) return;
  console.log('');
  console.log(`## ${failures.length} failed turn(s)`);
  for (const { scenario, turn } of failures) {
    const why = turn.error
      ? `call failed: ${turn.error}`
      : turn.desynced
        ? 'the script expected a tool call that never came'
        : turn.checks
            .filter((c) => !c.passed)
            .map((c) => c.detail)
            .join('; ');
    console.log('');
    console.log(`- ${scenario} turn ${turn.index} (${turn.capability}): ${why}`);
    console.log(`  said: ${turn.sent.replace(/\n/g, ' ').slice(0, 160)}`);
    console.log(`  got:  ${turn.reply.replace(/\n/g, ' ').slice(0, 240)}`);
  }
}

loadDotEnv();

const providerId = (arg('provider') ?? 'openrouter') as ProviderId;
const modelId = arg('model');
if (!modelId) {
  console.error('Provide --model <id> (the name the provider expects).');
  process.exit(2);
}
const languages = (arg('languages') ?? 'en,ko')
  .split(',')
  .map((l) => l.trim())
  .filter(Boolean) as MultiTurnLanguage[];
const only = arg('scenario');

const scenarios = multiTurnScenariosFor(languages).filter(
  (s) => !only || s.id === only,
);
if (scenarios.length === 0) {
  console.error('No scenario matched. Check --languages / --scenario.');
  process.exit(2);
}

const report = await runMultiTurnHarness({
  modelId,
  providerId,
  scenarios,
  onProgress: ({ done, total, message }) => {
    if (done === total || done === 0) console.error(`[${done}/${total}] ${message}`);
  },
});

printReport(report);

if (arg('json')) {
  console.log('');
  console.log(JSON.stringify(report, null, 2));
}

// A model that answers badly is a result, not a broken run. A model that never
// answered at all is a configuration problem, and should not exit clean.
const everyTurnErrored = report.callErrors > 0 && report.callErrors === report.byDepth.reduce((n, d) => n + d.turns, 0);
process.exit(everyTurnErrored ? 1 : 0);
