import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { findRepoRoot, readStudyConfigs, studyWithPython } from '@redrob/harness/generate';
import { generateBridgeOptions } from '@/lib/generate/bridge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** A study is many model calls. Generous, because the mock finishes in under a second. */
export const maxDuration = 800;

const PINNED_CREATED_AT = '2026-01-01T00:00:00Z';

interface Body {
  configPath?: unknown;
  /** Refuse to run anything that would reach a provider. Defaults to true. */
  offlineOnly?: unknown;
}

/**
 * POST /api/generate/study — run a study and return the artifact plus the table.
 *
 * The publication gate always runs. The CLI writes the artifact before checking it, so
 * asking costs nothing and the alternative — reporting `publishable` when nothing was
 * checked — would be the page asserting something it had not established. Refusal is a
 * result, carried back with Python's own reason rather than one re-derived here.
 *
 * Two guards worth naming. The config path must be one the catalog offered, so this is
 * not a "run any file on the server" endpoint. And `offlineOnly` defaults to true, so a
 * click cannot spend money by accident: a config with a `harness` model is refused
 * unless the caller has explicitly said otherwise.
 */
export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const configPath = typeof body.configPath === 'string' ? body.configPath : '';
  const offlineOnly = body.offlineOnly !== false;
  if (configPath === '') {
    return Response.json({ error: 'configPath is required' }, { status: 400 });
  }

  const root = await findRepoRoot().catch(() => null);
  if (!root) {
    return Response.json({ error: 'could not locate the repository root' }, { status: 500 });
  }

  const known = await readStudyConfigs(root);
  const summary = known.find((entry) => entry.path === configPath);
  if (!summary) {
    return Response.json(
      { error: `${configPath} is not one of the study configs this repository ships` },
      { status: 400 },
    );
  }
  if (offlineOnly && !summary.offline) {
    return Response.json(
      {
        error:
          `${summary.id} declares models that reach a provider, and this request asked ` +
          'to stay offline. Run it from the CLI, where the spend is deliberate.',
      },
      { status: 400 },
    );
  }

  const absolute = resolve(root, configPath);
  if (!absolute.startsWith(root + sep)) {
    return Response.json({ error: 'configPath escapes the repository' }, { status: 400 });
  }

  const outDirectory = await mkdtemp(join(tmpdir(), 'redrob-study-'));
  try {
    const bridge = await generateBridgeOptions(root);
    const outcome = await studyWithPython(
      { configPath: absolute, outDirectory, createdAt: PINNED_CREATED_AT, publish: true },
      { ...bridge.options, timeoutMs: 600_000 },
    );
    if (!outcome.available) {
      return Response.json({ error: outcome.reason, detail: outcome.detail }, { status: 503 });
    }
    return Response.json({
      result: outcome.result,
      table: outcome.table,
      publishable: outcome.publishable,
      refusal: outcome.refusal,
    });
  } finally {
    await rm(outDirectory, { recursive: true, force: true });
  }
}
