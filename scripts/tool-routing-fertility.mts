/**
 * Measure tokenizer fertility for tool-routing SLM candidates.
 * No inference — loads tokenizers only. Needs network the first time.
 *
 *   yarn tool-routing:fertility
 *   yarn tool-routing:fertility --include-eval-only
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  formatFertilityMarkdown,
  loadStubFertilityCorpus,
  measureToolRoutingFertility,
} from '../packages/harness/src/lib/tool-routing/index.ts';

const includeEvalOnly = process.argv.includes('--include-eval-only');
const outIdx = process.argv.indexOf('--out');
const outPath =
  outIdx >= 0 && process.argv[outIdx + 1]
    ? resolve(process.argv[outIdx + 1]!)
    : resolve('exports/tool-routing-fertility.json');

const corpus = loadStubFertilityCorpus();
const cells = await measureToolRoutingFertility({
  corpus,
  includeEvalOnly,
  onProgress: (p) => console.error(`${p.done}/${p.total} ${p.message}`),
});

writeFileSync(outPath, `${JSON.stringify({ cells }, null, 2)}\n`, 'utf8');
console.log(formatFertilityMarkdown(cells));
console.error(`wrote ${outPath}`);
