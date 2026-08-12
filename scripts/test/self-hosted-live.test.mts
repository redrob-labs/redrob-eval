/**
 * The catalog row for the self-hosted endpoint has to name the weights that are
 * actually loaded, not the deploy default. These tests stand up a fake
 * OpenAI-compatible /v1/models on loopback, so they stay offline.
 * Run: yarn test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { AddressInfo } from 'node:net';

import {
  SELF_HOSTED_CANDIDATES,
  SERVED_MODEL_NAME,
  baseUrlForServedName,
  slotServedName,
  vllmSlotEndpoints,
} from '../../packages/harness/src/config/self-hosted.ts';
import { TOOL_ROUTING_MODELS } from '../../packages/harness/src/lib/tool-routing/models.ts';
import { probeVllmEndpoint } from '../../packages/harness/src/lib/providers/vllm.ts';
import {
  getLiveSelfHostedModel,
  getLiveSelfHostedSlots,
  resetLiveSelfHostedCache,
  syncSelfHostedRef,
} from '../../packages/harness/src/lib/catalog/self-hosted-live.ts';
import { resolveModel } from '../../packages/harness/src/lib/catalog/resolve.ts';
/** A /v1/models that answers like vLLM: alias in `id`, weights in `root`. */
async function fakeVllm(
  rows: unknown[] | (() => unknown[]),
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (!req.url?.endsWith('/models')) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: typeof rows === 'function' ? rows() : rows }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}

async function withEnv<T>(
  env: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('probe reads the weights behind the served alias', async () => {
  const srv = await fakeVllm([
    { id: SERVED_MODEL_NAME, root: 'LiquidAI/LFM2.5-1.2B-Instruct', max_model_len: 8192 },
  ]);
  try {
    const probe = await probeVllmEndpoint({
      baseUrl: srv.baseUrl,
      apiKey: 'test-key',
      servedModelId: SERVED_MODEL_NAME,
      timeoutMs: 2000,
    });
    assert.equal(probe.reachable, true);
    assert.equal(probe.servedModelFound, true);
    assert.equal(probe.servedModel?.root, 'LiquidAI/LFM2.5-1.2B-Instruct');
    assert.equal(probe.servedModel?.maxModelLen, 8192);
    assert.deepEqual(probe.servedModels, [SERVED_MODEL_NAME]);
  } finally {
    await srv.close();
  }
});

test('a row without root leaves the weights unknown rather than guessed', async () => {
  const srv = await fakeVllm([{ id: SERVED_MODEL_NAME }]);
  try {
    const probe = await probeVllmEndpoint({
      baseUrl: srv.baseUrl,
      apiKey: 'test-key',
      servedModelId: SERVED_MODEL_NAME,
      timeoutMs: 2000,
    });
    assert.equal(probe.servedModelFound, true);
    assert.equal(probe.servedModel?.root, null);
    assert.equal(probe.servedModel?.maxModelLen, null);
  } finally {
    await srv.close();
  }
});

test('the live catalog row follows the endpoint, not the deploy default', async () => {
  const srv = await fakeVllm([
    { id: SERVED_MODEL_NAME, root: 'LiquidAI/LFM2.5-2.6B', max_model_len: 4096 },
  ]);
  try {
    resetLiveSelfHostedCache();
    const live = await withEnv(
      { VLLM_API_KEY: 'test-key', VLLM_BASE_URL: srv.baseUrl },
      () => getLiveSelfHostedModel({ forceRefresh: true }),
    );
    assert.equal(live.reachable, true);
    assert.equal(live.hfRepoId, 'LiquidAI/LFM2.5-2.6B');
    assert.equal(live.maxModelLen, 4096);
    // Resolved through the candidate list, so the picker shows a real name.
    assert.equal(live.label, 'LFM2.5 2.6B');
  } finally {
    resetLiveSelfHostedCache();
    await srv.close();
  }
});

test('a deploy model change invalidates a still-fresh live catalog row', async () => {
  let rows = [
    { id: SERVED_MODEL_NAME, root: 'LiquidAI/LFM2.5-2.6B', max_model_len: 4096 },
  ];
  const srv = await fakeVllm(() => rows);
  try {
    resetLiveSelfHostedCache();
    await withEnv(
      {
        VLLM_API_KEY: 'test-key',
        VLLM_BASE_URL: srv.baseUrl,
        MEASURED_MODEL_HF: 'LiquidAI/LFM2.5-2.6B',
      },
      async () => {
        const before = await getLiveSelfHostedModel({ forceRefresh: true });
        assert.equal(before.hfRepoId, 'LiquidAI/LFM2.5-2.6B');

        rows = [{ id: SERVED_MODEL_NAME, root: 'Qwen/Qwen3.5-4B', max_model_len: 8192 }];
        process.env.MEASURED_MODEL_HF = 'Qwen/Qwen3.5-4B';

        const after = await getLiveSelfHostedModel();
        assert.equal(after.hfRepoId, 'Qwen/Qwen3.5-4B');
        assert.equal(after.label, 'Qwen3.5 4B');
      },
    );
  } finally {
    resetLiveSelfHostedCache();
    await srv.close();
  }
});

test('an unknown repo still names itself instead of falling back to the default', async () => {
  const srv = await fakeVllm([{ id: SERVED_MODEL_NAME, root: 'someone/not-in-catalog' }]);
  try {
    resetLiveSelfHostedCache();
    const live = await withEnv(
      { VLLM_API_KEY: 'test-key', VLLM_BASE_URL: srv.baseUrl },
      () => getLiveSelfHostedModel({ forceRefresh: true }),
    );
    assert.equal(live.hfRepoId, 'someone/not-in-catalog');
    assert.equal(live.label, 'someone/not-in-catalog');
  } finally {
    resetLiveSelfHostedCache();
    await srv.close();
  }
});

test('a dead endpoint reports unreachable instead of throwing', async () => {
  resetLiveSelfHostedCache();
  try {
    const live = await withEnv(
      // Port 1 is reserved and never listening, so this is a refused connection.
      { VLLM_API_KEY: 'test-key', VLLM_BASE_URL: 'http://127.0.0.1:1/v1' },
      () => getLiveSelfHostedModel({ forceRefresh: true }),
    );
    assert.equal(live.reachable, false);
    assert.equal(live.hfRepoId, null);
    assert.ok(live.error);
  } finally {
    resetLiveSelfHostedCache();
  }
});

test('a run labels the model the endpoint is serving, not the deploy default', async () => {
  const srv = await fakeVllm([
    { id: SERVED_MODEL_NAME, root: 'Qwen/Qwen3.5-4B', max_model_len: 4096 },
  ]);
  try {
    resetLiveSelfHostedCache();
    const resolved = await withEnv(
      { VLLM_API_KEY: 'test-key', VLLM_BASE_URL: srv.baseUrl },
      () => resolveModel('vllm-endpoint'),
    );
    assert.equal(resolved?.label, 'Self-hosted: Qwen3.5 4B');
    assert.equal(resolved?.selfHosted?.hfRepoId, 'Qwen/Qwen3.5-4B');
    assert.equal(resolved?.selfHosted?.maxModelLen, 4096);
    // The alias is what gets called, and swapping the weights must not move it.
    assert.equal(resolved?.modelId, SERVED_MODEL_NAME);
    // Throughput measured on the old weights says nothing about the new ones.
    assert.equal(resolved?.selfHosted?.measuredTokPerSec, null);
    assert.equal(resolved?.selfHosted?.precision, 'pending');
  } finally {
    resetLiveSelfHostedCache();
    await srv.close();
  }
});

test('an endpoint that is off leaves the catalog row alone', async () => {
  resetLiveSelfHostedCache();
  try {
    const row = {
      label: 'Self-hosted: Gemma 4 E4B',
      selfHosted: {
        hfRepoId: 'google/gemma-4-E4B-it',
        license: 'apache-2.0' as const,
        precision: 'bf16' as const,
        maxModelLen: 8192,
        servedModelName: SERVED_MODEL_NAME,
        measuredTokPerSec: 42,
        measuredAt: '2026-08-01T00:00:00.000Z',
      },
    };
    const synced = await withEnv(
      { VLLM_API_KEY: 'test-key', VLLM_BASE_URL: 'http://127.0.0.1:1/v1' },
      () => syncSelfHostedRef(row),
    );
    assert.deepEqual(synced, row, 'a down host is not evidence of a swap');
  } finally {
    resetLiveSelfHostedCache();
  }
});

test('slot endpoints follow the base port, so a second deploy needs no settings edit', () => {
  const slots = vllmSlotEndpoints({ VLLM_BASE_URL: 'http://gpu.example:8101/v1' });
  assert.ok(slots.length >= 2, 'a host must be able to hold more than one slot');
  assert.equal(slots[0]?.baseUrl, 'http://gpu.example:8101/v1');
  assert.equal(slots[0]?.servedName, slotServedName(0));
  assert.equal(slots[1]?.baseUrl, 'http://gpu.example:8102/v1');
  assert.equal(slots[1]?.servedName, slotServedName(1));
});

test('an explicit slot map wins over the derived ports', () => {
  const env = {
    VLLM_BASE_URL: 'http://gpu.example:8101/v1',
    VLLM_SLOT_URLS: 'redrob-s0=http://a.example:9000/v1,redrob-s1=http://b.example:9100/v1',
  };
  const slots = vllmSlotEndpoints(env);
  assert.equal(slots.length, 2);
  assert.equal(slots[1]?.baseUrl, 'http://b.example:9100/v1');
  // Routing by alias is what keeps a two-model run from sending both calls to
  // the same slot, which is how the second model used to 404.
  assert.equal(baseUrlForServedName('redrob-s1', env), 'http://b.example:9100/v1');
  assert.equal(baseUrlForServedName('redrob-s0', env), 'http://a.example:9000/v1');
  assert.equal(baseUrlForServedName('something-else', env), null);
});

test('two serving slots both appear, each naming its own weights', async () => {
  const s0 = await fakeVllm([
    { id: slotServedName(0), root: 'google/gemma-4-E4B-it', max_model_len: 8192 },
  ]);
  const s1 = await fakeVllm([
    { id: slotServedName(1), root: 'LiquidAI/LFM2.5-2.6B', max_model_len: 4096 },
  ]);
  try {
    resetLiveSelfHostedCache();
    const slots = await withEnv(
      {
        VLLM_API_KEY: 'test-key',
        VLLM_SLOT_URLS: `${slotServedName(0)}=${s0.baseUrl},${slotServedName(1)}=${s1.baseUrl}`,
      },
      () => getLiveSelfHostedSlots({ forceRefresh: true }),
    );
    assert.equal(slots.length, 2);
    assert.equal(slots[0]?.hfRepoId, 'google/gemma-4-E4B-it');
    assert.equal(slots[1]?.hfRepoId, 'LiquidAI/LFM2.5-2.6B');
    assert.equal(slots[1]?.maxModelLen, 4096);
    assert.equal(slots[1]?.baseUrl, s1.baseUrl);
  } finally {
    resetLiveSelfHostedCache();
    await s0.close();
    await s1.close();
  }
});

test('a slot that is not serving is dropped rather than shown as broken', async () => {
  const s0 = await fakeVllm([
    { id: slotServedName(0), root: 'google/gemma-4-E4B-it', max_model_len: 8192 },
  ]);
  try {
    resetLiveSelfHostedCache();
    const slots = await withEnv(
      {
        VLLM_API_KEY: 'test-key',
        VLLM_SLOT_URLS: `${slotServedName(0)}=${s0.baseUrl},${slotServedName(1)}=http://127.0.0.1:1/v1`,
      },
      () => getLiveSelfHostedSlots({ forceRefresh: true }),
    );
    assert.equal(slots.length, 1);
    assert.equal(slots[0]?.slot, 0);
  } finally {
    resetLiveSelfHostedCache();
    await s0.close();
  }
});

test('a run against slot 1 resolves slot 1 weights, not slot 0', async () => {
  const s0 = await fakeVllm([
    { id: slotServedName(0), root: 'google/gemma-4-E4B-it', max_model_len: 8192 },
  ]);
  const s1 = await fakeVllm([
    { id: slotServedName(1), root: 'Qwen/Qwen3.5-4B', max_model_len: 4096 },
  ]);
  try {
    resetLiveSelfHostedCache();
    await withEnv(
      {
        VLLM_API_KEY: 'test-key',
        VLLM_SLOT_URLS: `${slotServedName(0)}=${s0.baseUrl},${slotServedName(1)}=${s1.baseUrl}`,
      },
      async () => {
        const one = await resolveModel(`vllm/${slotServedName(1)}`);
        assert.equal(one?.selfHosted?.hfRepoId, 'Qwen/Qwen3.5-4B');
        assert.equal(one?.modelId, slotServedName(1));

        const zero = await resolveModel('vllm-endpoint-s0');
        assert.equal(zero?.selfHosted?.hfRepoId, 'google/gemma-4-E4B-it');
        // Distinct ids are what let one run hold both models at once.
        assert.notEqual(one?.canonicalId, zero?.canonicalId);
      },
    );
  } finally {
    resetLiveSelfHostedCache();
    await s0.close();
    await s1.close();
  }
});

test('a candidate shared with tool routing points at the same repo', () => {
  const shared = TOOL_ROUTING_MODELS.filter((m) => m.id in SELF_HOSTED_CANDIDATES);
  // The two registries are keyed alike on purpose; an empty overlap means the
  // convention was dropped and Deploy can no longer serve what Compare picks.
  assert.ok(shared.length > 0);
  for (const m of shared) {
    const candidate = SELF_HOSTED_CANDIDATES[m.id as keyof typeof SELF_HOSTED_CANDIDATES];
    assert.equal(candidate.hfRepoId, m.hfRepoId, `${m.id} repo id drifted`);
  }
});

test('every eval_only model stays out of the deploy catalog', () => {
  for (const m of TOOL_ROUTING_MODELS) {
    if (m.usable !== 'eval_only') continue;
    assert.ok(!(m.id in SELF_HOSTED_CANDIDATES), `${m.id} must not be deployable`);
  }
});

test('LFM2.5 is testable from both Compare and Deploy', () => {
  const lfm = TOOL_ROUTING_MODELS.filter((m) => m.hfRepoId.startsWith('LiquidAI/LFM2.5-'));
  assert.ok(lfm.length >= 5);
  for (const m of lfm) {
    assert.equal(m.license, 'lfm1.0');
    assert.equal(m.usable, true);
    // The commercial grant lapses at $10M revenue, so the limit has to be on screen.
    assert.match(m.notes ?? '', /\$10M revenue/);
    assert.ok(m.id in SELF_HOSTED_CANDIDATES, `${m.id} is not deployable`);
  }
});
