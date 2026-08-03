import { listPublicCompareRegistry, assertNoCurrencyInValue } from '@redrob/harness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/compare/registry
 * Public catalog — rates omitted. Illustrative snapshots only.
 */
export async function GET() {
  const models = listPublicCompareRegistry();
  assertNoCurrencyInValue(models, 'public compare registry');
  return Response.json({
    models,
    note: 'Illustrative registry — replace/extend packages/harness/src/lib/compare/registry/models.json. Rates are never returned.',
  });
}
