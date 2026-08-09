// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * What happens when a reasoning model spends the whole token budget thinking.
 *
 * Found against a live provider: `qwen/qwen3.7-flash` on the GSM8K task, whose cap is 512
 * tokens, returned `finish_reason: length` with 512 reasoning tokens and no content at
 * all. The harness turned that into "Empty model response", the eval scored it 0, and the
 * ranking reported a capable model as the worst one on the board.
 *
 * That is the failure mode an evaluation tool must never have: an instrumentation limit
 * of our own making, reported as a fact about the model. These tests run against a local
 * stub rather than a provider, so they cost nothing and cannot flake on someone's quota.
 */
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import test from 'node:test';

import { createOpenAICompatAdapter } from '../../packages/harness/src/lib/providers/openai-compat';
import { ProviderError } from '../../packages/harness/src/lib/providers/types';

interface Recorded {
  maxTokens: number | undefined;
}

/**
 * A stub that thinks until it is given room to answer.
 *
 * `answerAt` is the budget at which it stops reasoning and replies, so a test can say
 * "this model needs more than the caller offered" without pretending to be a real model.
 */
async function withStub(
  answerAt: number,
  run: (baseUrl: string, calls: Recorded[]) => Promise<void>,
): Promise<Recorded[]> {
  const calls: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { max_tokens?: number };
      const cap = body.max_tokens;
      calls.push({ maxTokens: cap });
      const enough = cap != null && cap >= answerAt;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: { content: enough ? 'the answer is 284\n#### 284' : '' },
              finish_reason: enough ? 'stop' : 'length',
            },
          ],
          usage: {
            prompt_tokens: 80,
            completion_tokens: enough ? answerAt + 40 : cap,
            completion_tokens_details: { reasoning_tokens: enough ? answerAt : cap },
          },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await run(`http://127.0.0.1:${port}/v1`, calls);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return calls;
}

const adapter = createOpenAICompatAdapter('openrouter');

function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  return fn().finally(() => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test('a reasoning model that runs out of budget', async (t) => {
  await t.test('is asked again with room to answer rather than reported as empty', async () => {
    let result: { text: string } | undefined;
    const calls = await withStub(900, async (baseUrl) => {
      await withEnv({ OPENROUTER_API_KEY: 'test', OPENROUTER_BASE_URL: baseUrl }, async () => {
        result = await adapter.call({ modelId: 'stub/thinker', prompt: 'q', maxTokens: 512 });
      });
    });

    assert.equal(calls.length, 2, 'should have re-asked exactly once');
    assert.equal(calls[0]!.maxTokens, 512, 'first ask uses the caller’s cap');
    assert.ok(
      calls[1]!.maxTokens! >= 900,
      `re-ask should clear the thinking, got ${calls[1]!.maxTokens}`,
    );
    assert.match(result!.text, /284/);
  });

  await t.test('is only re-asked once, however much it wants to think', async () => {
    // A model that never answers must not be able to bill the caller in a loop.
    const calls = await withStub(1e9, async (baseUrl) => {
      await withEnv({ OPENROUTER_API_KEY: 'test', OPENROUTER_BASE_URL: baseUrl }, async () => {
        await assert.rejects(
          () => adapter.call({ modelId: 'stub/thinker', prompt: 'q', maxTokens: 512 }),
          ProviderError,
        );
      });
    });
    assert.equal(calls.length, 2);
  });

  await t.test('says it was cut off, not that the model said nothing', async () => {
    // "Empty model response" reads as a fact about the model. It was a fact about our cap,
    // and the difference decides whether someone re-runs or discards the model.
    await withStub(1e9, async (baseUrl) => {
      await withEnv({ OPENROUTER_API_KEY: 'test', OPENROUTER_BASE_URL: baseUrl }, async () => {
        await assert.rejects(
          () => adapter.call({ modelId: 'stub/thinker', prompt: 'q', maxTokens: 512 }),
          /cut off/,
        );
      });
    });
  });

  await t.test('is re-asked when its answer stops mid-sentence, not only when blank', async () => {
    // The second failure mode from the same live run: reasoning finished, the answer
    // started, and the cap landed in the middle of it. Scoring that measures the cap.
    const calls: Recorded[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const cap = (JSON.parse(raw || '{}') as { max_tokens?: number }).max_tokens;
        calls.push({ maxTokens: cap });
        const roomy = (cap ?? 0) >= 2048;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: roomy ? 'planted 30, five failed\n#### 25' : 'planted 30, since 5 of them',
                },
                finish_reason: roomy ? 'stop' : 'length',
              },
            ],
            usage: {
              completion_tokens: cap,
              completion_tokens_details: { reasoning_tokens: Math.floor((cap ?? 0) * 0.9) },
            },
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    let text = '';
    try {
      await withEnv(
        { OPENROUTER_API_KEY: 'test', OPENROUTER_BASE_URL: `http://127.0.0.1:${port}/v1` },
        async () => {
          ({ text } = await adapter.call({
            modelId: 'stub/thinker',
            prompt: 'q',
            maxTokens: 512,
          }));
        },
      );
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    assert.equal(calls.length, 2);
    assert.match(text, /#### 25/, 'should return the finished answer, not the truncated one');
  });

  await t.test('does not raise the budget when the model simply returned nothing', async () => {
    // finish_reason `stop` with empty content is the model's own doing. Paying for a
    // second, larger call would be inventing a problem to solve.
    const calls: Recorded[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        calls.push({ maxTokens: (JSON.parse(raw || '{}') as { max_tokens?: number }).max_tokens });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: '' }, finish_reason: 'stop' }],
            usage: { completion_tokens: 0, completion_tokens_details: { reasoning_tokens: 0 } },
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      await withEnv(
        { OPENROUTER_API_KEY: 'test', OPENROUTER_BASE_URL: `http://127.0.0.1:${port}/v1` },
        async () => {
          await assert.rejects(
            () => adapter.call({ modelId: 'stub/quiet', prompt: 'q', maxTokens: 512 }),
            /Empty model response/,
          );
        },
      );
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    assert.equal(calls.length, 1, 'no re-ask for a model that stopped of its own accord');
  });
});
