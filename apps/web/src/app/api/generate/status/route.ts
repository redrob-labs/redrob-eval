import { findRepoRoot, probePythonBridge, UNICODE_VERSION } from '@redrob/harness/generate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/generate/status — what the Generate page can and cannot do right now.
 *
 * Generation is Python-only: this runtime reads and verifies but does not sample, so
 * there is no fallback to degrade to when the CLI is missing. Rather than let the page
 * find that out one failed button at a time, it asks once and says so up front.
 *
 * A missing CLI is a 200 with `python.available: false`, not an error status. It is an
 * expected configuration — the workbench installs and runs without it — and a 500 would
 * make the page render an error where the honest answer is "install this if you want it".
 */
export async function GET() {
  const [python, root] = await Promise.all([
    probePythonBridge(),
    findRepoRoot().catch(() => null),
  ]);

  return Response.json({
    python: python.available
      ? { available: true as const, version: python.version }
      : { available: false as const, reason: python.reason },
    repoRoot: root,
    runtimes: [
      // Both, always, because the reason Python is normative for publication is that the
      // two read different Unicode tables, and that is only checkable with both numbers.
      {
        implementation: '@redrob/harness',
        implementationVersion: process.versions.node,
        unicodeVersion: UNICODE_VERSION,
        authoritative: false,
      },
    ],
  });
}
