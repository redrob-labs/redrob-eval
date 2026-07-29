#!/usr/bin/env node
/**
 * Smoke-test callModel via the running Next.js server.
 * Usage:
 *   yarn dev   # terminal 1
 *   yarn probe # terminal 2  (optional EVAL_MODEL_ID=or-gpt-4o-mini)
 */

const base = process.env.PROBE_BASE_URL ?? 'http://localhost:3939';
const evalModelId = process.env.EVAL_MODEL_ID ?? 'or-gpt-4o-mini';

async function main() {
  const statusRes = await fetch(`${base}/api/status`);
  const status = await statusRes.json();
  console.log('Configured providers:', status.providers.filter((p) => p.configured).map((p) => p.id));
  console.log('Callable models:', status.models.filter((m) => m.callable).map((m) => m.id));

  const probeRes = await fetch(`${base}/api/probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      evalModelId,
      prompt: 'Reply with exactly: ok',
    }),
  });
  const probe = await probeRes.json();
  console.log('Probe HTTP', probeRes.status, probe);
  if (!probe.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
