/**
 * Triage the failures in a run.
 *
 * A rate says how often a model was wrong. This says how, which is the part that
 * changes what you do next: a wrong wrapper is a parser or prompt fix, a wrong
 * tool is a description fix, and acting when it should have declined is neither.
 *
 *   yarn failures --run 2026-08-13_023853_tool-routing-matrix
 *   yarn failures --run <id> --kind envelope,format
 *   yarn failures --run <id> --model granite-4.1-8b --language ko
 *   yarn failures --run <id> --show 3          # side by side, in full
 *   yarn failures --run <id> --json out.json
 *
 * Reads the artifacts the run stored, so it never re-calls a model.
 */
import { writeFileSync } from 'node:fs';

import {
  createRunStore,
  failuresFromMultiTurn,
  failuresFromToolRouting,
  filterFailures,
  tallyFailures,
  RECOVERABLE_KINDS,
} from '@redrob/harness';
import type {
  FailureKind,
  FailureRecord,
  MultiTurnReport,
  ToolRoutingReport,
} from '@redrob/harness';

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
  console.error('Usage: yarn failures --run <run id> [--kind k1,k2] [--model m] [--show N]');
  process.exit(2);
}

const store = await createRunStore();
try {
  const run = await store.get(runId);
  if (!run) {
    console.error(`No run with id ${runId}`);
    process.exit(1);
  }

  const names = await store.listArtifacts(runId);
  if (names.length === 0) {
    console.error(
      `Run ${runId} kept no artifacts, so there is nothing to analyse.\n` +
        'Only runs that stored their full reports can be triaged.',
    );
    process.exit(1);
  }

  // Reports are recognised by shape rather than by artifact name, so a run that
  // mixes kinds - or names its artifacts differently - still reads.
  const failures: FailureRecord[] = [];
  for (const name of names) {
    const artifact = await store.readArtifact(runId, name);
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) continue;
    const schema = (artifact as { schema?: string }).schema;
    if (schema === 'redrob-tool-routing/v2') {
      failures.push(...failuresFromToolRouting(artifact as unknown as ToolRoutingReport));
    } else if (schema === 'redrob-multi-turn/v1') {
      failures.push(...failuresFromMultiTurn(artifact as unknown as MultiTurnReport));
    }
  }

  const kinds = arg('kind')
    ?.split(',')
    .map((k) => k.trim())
    .filter(Boolean) as FailureKind[] | undefined;
  const filtered = filterFailures(failures, {
    ...(kinds?.length ? { kind: kinds } : {}),
    ...(arg('model') ? { model: arg('model')! } : {}),
    ...(arg('language') ? { language: arg('language')! } : {}),
    ...(arg('tool') ? { tool: arg('tool')! } : {}),
    ...(arg('search') ? { search: arg('search')! } : {}),
    ...(arg('turn') ? { turn: Number(arg('turn')) } : {}),
  });

  console.log(`run ${runId}${run.label ? `  ${run.label}` : ''}`);
  console.log(
    `${failures.length} failure(s) across ${names.length} artifact(s)` +
      (filtered.length === failures.length ? '' : ` · ${filtered.length} match the filter`),
  );

  const tally = tallyFailures(filtered);
  if (tally.length) {
    console.log('');
    console.log('| kind | count | share |');
    console.log('| --- | --- | --- |');
    for (const row of tally) {
      console.log(`| ${row.kind} | ${row.count} | ${(row.share * 100).toFixed(0)}% |`);
    }
    // The split that decides what to do this afternoon.
    const recoverable = filtered.filter((f) => RECOVERABLE_KINDS.includes(f.kind)).length;
    if (recoverable > 0) {
      console.log(
        `\n${recoverable} of ${filtered.length} are wrapper or protocol failures ` +
          '(format, envelope, desynced) - a prompt or parser change, not a better model.',
      );
    }
  }

  const show = Number(arg('show') ?? '0') || 0;
  if (show > 0) {
    for (const f of filtered.slice(0, show)) {
      console.log('');
      console.log('─'.repeat(78));
      console.log(`${f.kind}  ${f.model}  ${f.item}${f.language ? ` (${f.language})` : ''}`);
      if (f.turn) console.log(`turn ${f.turn}${f.capability ? ` · ${f.capability}` : ''}`);
      console.log(`why       ${f.detail}`);
      if (f.expected) console.log(`expected  ${f.expected}`);
      if (f.prompt) console.log(`asked     ${f.prompt.replace(/\n/g, ' ')}`);
      console.log(`got       ${(f.actual ?? '').replace(/\n/g, ' ')}`);
    }
  } else if (filtered.length) {
    console.log('');
    for (const f of filtered.slice(0, 40)) {
      const where = `${f.item}${f.language ? `/${f.language}` : ''}${f.turn ? `#${f.turn}` : ''}`;
      console.log(`${f.kind.padEnd(19)} ${where.padEnd(28)} ${f.model.padEnd(34)} ${f.detail}`);
    }
    if (filtered.length > 40) {
      console.log(`\n… ${filtered.length - 40} more. Narrow with --kind / --model, or --json.`);
    }
    console.log('\nUse --show N to see the prompt and the reply in full.');
  }

  const out = arg('json');
  if (out) {
    writeFileSync(out, `${JSON.stringify(filtered, null, 2)}\n`, 'utf8');
    console.error(`wrote ${out}`);
  }
} finally {
  await store.close();
}
