import { NextResponse } from 'next/server';
import { SELF_HOSTED_CANDIDATES, SELF_HOSTED_DEFAULTS } from '@redrob/harness';

export const runtime = 'nodejs';

/**
 * GET /api/deploy/candidates
 *
 * The serving catalog, so the model picker on /deploy is not a second hand-kept
 * copy of it. Separate from /api/deploy/status because that route waits on SSH,
 * and a dropdown must not sit empty while a GPU host is slow to answer.
 */
export async function GET() {
  const candidates = Object.entries(SELF_HOSTED_CANDIDATES).map(([key, c]) => ({
    key,
    // Everything on this page is self-hosted, so the suffix is only noise here.
    label: c.label.replace(/\s*\(self-hosted\)$/, ''),
    hfRepoId: c.hfRepoId,
    tier: c.tier,
    license: c.license,
    notes: c.notes,
  }));

  return NextResponse.json({
    candidates,
    defaults: { model: SELF_HOSTED_DEFAULTS.model },
  });
}
