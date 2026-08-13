import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { emitWithPython, findRepoRoot } from '@redrob/harness/generate';
import { generateBridgeOptions } from '@/lib/generate/bridge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** Enough to see the parameters vary, few enough to render without paging. */
const MAX_COUNT = 25;

/**
 * Timestamp pinned so a preview is a pure function of its inputs. Nothing here is
 * published and the manifest is discarded, but a preview that changed every time it was
 * refreshed would undermine the one property the module is built on.
 */
const PINNED_CREATED_AT = '2026-01-01T00:00:00Z';

interface Body {
  templatePath?: unknown;
  locale?: unknown;
  count?: unknown;
}

/**
 * POST /api/generate/preview — generate a handful of instances and hand them back.
 *
 * Writes to a temporary directory and deletes it. The alternative, letting the caller
 * name an output path, would make this route an arbitrary-file-write primitive reachable
 * from a browser.
 */
export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const templatePath = typeof body.templatePath === 'string' ? body.templatePath : '';
  const locale = typeof body.locale === 'string' ? body.locale : 'en';
  const count = Math.min(Math.max(Number(body.count ?? 3) || 3, 1), MAX_COUNT);
  if (templatePath === '') {
    return Response.json({ error: 'templatePath is required' }, { status: 400 });
  }

  const root = await findRepoRoot().catch(() => null);
  if (!root) {
    return Response.json({ error: 'could not locate the repository root' }, { status: 500 });
  }

  // The path comes from a browser, so it is confined to the template tree rather than
  // trusted. The catalog only ever offers paths inside it; anything else is a caller
  // that built its own request.
  const templatesRoot = join(root, 'templates');
  const absolute = resolve(root, templatePath);
  if (absolute !== templatesRoot && !absolute.startsWith(templatesRoot + sep)) {
    return Response.json({ error: 'templatePath must be inside templates/' }, { status: 400 });
  }

  const outDirectory = await mkdtemp(join(tmpdir(), 'redrob-preview-'));
  try {
    const bridge = await generateBridgeOptions(root);
    const outcome = await emitWithPython(
      { templatePath: absolute, count, outDirectory, locale, createdAt: PINNED_CREATED_AT },
      bridge.options,
    );
    if (!outcome.available) {
      // 503 rather than 500: the request was fine, the capability is absent.
      return Response.json({ error: outcome.reason, detail: outcome.detail }, { status: 503 });
    }
    return Response.json({ instances: outcome.instances, manifest: outcome.manifest });
  } finally {
    await rm(outDirectory, { recursive: true, force: true });
  }
}
