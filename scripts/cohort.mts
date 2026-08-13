/**
 * Work with a saved cohort of failures.
 *
 * The point of saving a cohort is re-running it: a change was supposed to fix
 * these twelve items, and re-running the whole grid to find out costs an hour and
 * buries the answer. A cohort is a cell list, which is what the queue consumes,
 * so re-running one is the same machinery as running a matrix.
 *
 *   yarn cohort list
 *   yarn cohort show <cohortId>
 *   yarn cohort rerun <cohortId> [--provider openrouter]
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createRunStore,
  readCohort,
  runRegistryMatrix,
  runToolRoutingHarness,
  COHORT_KIND,
} from '@redrob/harness';
import type { ProviderId, RunJson as Json, ToolRoutingLanguage } from '@redrob/harness';
import { loadStubToolRoutingTasks } from '../packages/harness/src/lib/tool-routing/fixtures.ts';

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

process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

loadDotEnv();
const [command, id] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const store = await createRunStore();

try {
  if (command === 'list' || !command) {
    const runs = await store.list({ kind: COHORT_KIND, limit: 30 });
    if (runs.length === 0) {
      console.log('No cohorts saved yet.');
      console.log('Make one: yarn failures --run <id> --kind format --save-cohort "name"');
    }
    for (const run of runs) {
      const members = (run.summary as { members?: number } | undefined)?.members ?? 0;
      console.log(`${run.id}  ${String(members).padStart(4)} member(s)  ${run.label ?? ''}`);
    }
  } else if (command === 'show') {
    const cohort = id ? await readCohort(store, id) : null;
    if (!cohort) {
      console.error(`No cohort with id ${id}`);
      process.exit(1);
    }
    console.log(`${cohort.id}  ${cohort.name}`);
    console.log(`  from run  ${cohort.sourceRunId}`);
    console.log(`  filter    ${JSON.stringify(cohort.filter)}`);
    console.log(`  ${cohort.members.length} member(s):`);
    for (const m of cohort.members) {
      console.log(`    ${m.kind.padEnd(18)} ${m.item.padEnd(30)} ${m.model}`);
    }
  } else if (command === 'rerun') {
    const cohort = id ? await readCohort(store, id) : null;
    if (!cohort) {
      console.error(`No cohort with id ${id}`);
      process.exit(1);
    }
    const provider = (arg('provider') ?? 'openrouter') as ProviderId;
    const allTasks = loadStubToolRoutingTasks();
    const byId = new Map(allTasks.map((t) => [t.id, t]));

    // One cell per member, so only the items in the cohort are called. The key
    // is the member itself rather than a hash of the grid: this is a set, not a
    // product, and the key has to identify the item it re-runs. It also becomes
    // an artifact name, so it is restricted to what those allow.
    const cells = cohort.members
      .filter((m) => byId.has(m.item))
      .map((m) => ({
        key: `${m.model}--${m.item}`.replace(/[^A-Za-z0-9._-]/g, '-'),
        params: { model: m.model, item: m.item } as Json,
      }));
    const missing = cohort.members.length - cells.length;
    if (cells.length === 0) {
      console.error('None of this cohort\'s items exist in the current fixtures.');
      process.exit(1);
    }
    console.error(
      `Re-running ${cells.length} item(s) from ${cohort.name}` +
        (missing ? ` (${missing} no longer in the fixtures)` : ''),
    );

    const { runId, result } = await runRegistryMatrix({
      store,
      kind: 'cohort-rerun',
      label: `rerun: ${cohort.name}`,
      tags: ['cohort-rerun'],
      models: [...new Set(cohort.members.map((m) => m.model))],
      cells,
      extraParams: { cohortId: cohort.id, sourceRunId: cohort.sourceRunId, provider },
      concurrency: Number(arg('concurrency') ?? '2') || 2,
      maxAttempts: 2,
      async worker(cell, { runId: currentRun }) {
        const { model, item } = cell.params as { model: string; item: string };
        const task = byId.get(item)!;
        const report = await runToolRoutingHarness({
          modelId: model,
          servedModelId: model,
          providerId: provider,
          tasks: [task],
          languages: [task.language as ToolRoutingLanguage],
          conditions: ['contract'],
        });
        await store.putArtifact(currentRun, `cell-${cell.key}`, report as unknown as Json);
        const example = report.examples?.[0];
        const stillFailing = Boolean(
          example &&
            (example.score.parseFailed ||
              example.score.toolSelectCorrect === false ||
              example.score.argExactMatch === false ||
              example.score.absenceCorrect === false),
        );
        return { model, item, stillFailing } as Json;
      },
    });

    // The only number that matters on a re-run: how many of them are fixed.
    const fixed = result.outcomes.filter(
      (o) => o.status === 'done' && (o.summary as { stillFailing?: boolean })?.stillFailing === false,
    ).length;
    const still = result.outcomes.filter(
      (o) => o.status === 'done' && (o.summary as { stillFailing?: boolean })?.stillFailing === true,
    ).length;
    console.log('');
    console.log(`run ${runId}`);
    console.log(`  ${fixed} now pass · ${still} still fail · ${result.failed} could not be run`);
    console.log(`  inspect the rest with: yarn failures --run ${runId}`);
  } else {
    console.error('Usage: yarn cohort [list|show <id>|rerun <id>]');
    process.exit(2);
  }
} finally {
  await store.close();
}
