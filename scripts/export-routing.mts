#!/usr/bin/env tsx
/**
 * Export routing corpus for SLM training.
 *
 *   yarn export:routing
 *   yarn export:routing --format=flat --out=./exports/routing-flat.jsonl
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  computeAndWriteCorpusStats,
  exportTrainJsonl,
  readAllCorpusExamples,
} from '../packages/harness/src/index';

async function main() {
  const args = process.argv.slice(2);
  const format = args.find((a) => a.startsWith('--format='))?.split('=')[1] === 'flat'
    ? 'flat'
    : 'chat';
  const out =
    args.find((a) => a.startsWith('--out='))?.slice('--out='.length) ||
    join(process.cwd(), 'exports', `routing-${format}.jsonl`);

  const examples = await readAllCorpusExamples();
  const stats = await computeAndWriteCorpusStats();
  const body = exportTrainJsonl(examples, format);

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, body, 'utf8');
  console.log(`Wrote ${out} (${examples.length} examples)`);
  console.log(
    `Corpus stats: examples=${stats.exampleCount} runs=${stats.runCount} last=${stats.lastUpdatedAt}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
