import { listSuites } from '@/lib/image-eval';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/image/suites */
export async function GET() {
  const suites = await listSuites();
  return Response.json({
    suites: suites.map((s) => ({
      id: s.suite,
      label: s.suite,
      description: s.description,
      promptCount: s.prompts.length,
      scoring: s.scoring,
      notes: s.notes ?? null,
    })),
  });
}
