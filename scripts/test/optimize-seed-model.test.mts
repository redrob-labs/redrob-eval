// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * Which model an Evolve run actually optimises.
 *
 * Found with a live key. The Seed model dropdown was set to Llama 3.1 8B, the run
 * manifest duly recorded `openrouter:meta-llama/llama-3.1-8b-instruct` — and every
 * rollout went to `openai/gpt-4o`, because the seed candidate took `modelCatalog[0]`
 * rather than the seed model, and the page sends its model-picker selection as the
 * catalog. The report then attributed the result to the wrong model, and the run cost
 * roughly fifty times what was asked for.
 *
 * The unit under test is the choice of gene, so it is exercised directly rather than
 * through a job: starting a real run needs a provider, a dataset and a network.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { seedCandidate } from '../../packages/harness/src/lib/optimizer/types';
import type { ModelGene } from '../../packages/harness/src/lib/optimizer/types';

const llama: ModelGene = {
  catalogId: 'or-llama-8b',
  modelId: 'meta-llama/llama-3.1-8b-instruct',
  providerId: 'openrouter',
  relativeCostWeight: 2,
};

const gpt4o: ModelGene = {
  catalogId: 'or-gpt-4o',
  modelId: 'openai/gpt-4o',
  providerId: 'openrouter',
  relativeCostWeight: 100,
};

test('the seed candidate', async (t) => {
  await t.test('carries the model it was seeded with', () => {
    const seed = seedCandidate({ instruction: 'solve it', model: llama });
    assert.equal(seed.model.modelId, 'meta-llama/llama-3.1-8b-instruct');
  });

  await t.test('is not the first entry of the mutation pool', () => {
    // The regression, stated as the thing that must not happen: a pool whose first entry
    // is some other model must not decide what the run starts on. `seedCandidate` takes
    // the gene it is handed, so this pins the caller's obligation to hand it the seed.
    const pool = [gpt4o, llama];
    const wrong = seedCandidate({ instruction: 'solve it', model: pool[0]! });
    const right = seedCandidate({ instruction: 'solve it', model: llama });
    assert.equal(wrong.model.modelId, 'openai/gpt-4o');
    assert.equal(right.model.modelId, 'meta-llama/llama-3.1-8b-instruct');
    assert.notEqual(right.model.modelId, pool[0]!.modelId);
  });

  await t.test('keeps the seed model’s cost weight, which the report is scaled by', () => {
    // Baseline-relative cost is computed against the seed. Seeding with the wrong gene
    // silently rebases every "% of baseline" figure in the report as well.
    const seed = seedCandidate({ instruction: 'solve it', model: llama });
    assert.equal(seed.model.relativeCostWeight, 2);
  });
});

test('the optimize runner wires the seed model into the seed candidate', async () => {
  // A source-level check, because constructing a job needs a provider and a network.
  // It is the assignment itself that regressed, and it is one line.
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    new URL('../../packages/harness/src/lib/jobs/optimize-runner.ts', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /model:\s*seedGene,/,
    'the seed candidate must be built from the seed model',
  );
  assert.doesNotMatch(
    source,
    /model:\s*modelCatalog\[0\]/,
    'the mutation pool must not decide what the run starts on',
  );
});
