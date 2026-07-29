import {
  exportTrainJsonl,
  readAllCorpusExamples,
  readCorpusStats,
  readRoutingExamples,
} from '@redrob/harness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/routing/export?format=chat|flat&runId=&datasetId=&label=
 * Returns JSONL for routing-SLM training.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const format = searchParams.get('format') === 'flat' ? 'flat' : 'chat';
  const runId = searchParams.get('runId');
  const datasetId = searchParams.get('datasetId');
  const label = searchParams.get('label');

  let examples = runId
    ? await readRoutingExamples(runId)
    : await readAllCorpusExamples();

  if (datasetId) {
    examples = examples.filter((e) => e.datasetId === datasetId);
  }
  if (label === 'small' || label === 'large') {
    examples = examples.filter((e) => e.label === label);
  }

  const body = exportTrainJsonl(examples, format);
  const stats = await readCorpusStats();

  return new Response(body, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': `attachment; filename="routing-${format}-${runId || 'corpus'}.jsonl"`,
      'X-Example-Count': String(examples.length),
      'X-Corpus-Total': String(stats.exampleCount),
    },
  });
}
