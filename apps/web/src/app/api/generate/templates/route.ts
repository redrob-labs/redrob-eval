import { readStudyConfigs, readTemplateCatalog } from '@redrob/harness/generate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/generate/templates — the template tree and the shipped study configs.
 *
 * Reads the filesystem and nothing else. This is the one part of Generate that works
 * without the Python CLI, which is why it is a separate route: a workbench without
 * generation installed can still show what templates exist, in which locales, and how
 * reviewed each one is.
 */
export async function GET() {
  try {
    const [templates, studies] = await Promise.all([readTemplateCatalog(), readStudyConfigs()]);
    return Response.json({ templates, studies });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'could not read the template catalog' },
      { status: 500 },
    );
  }
}
