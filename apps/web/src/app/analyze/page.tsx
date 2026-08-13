import { AnalyzeApp } from '@/components/analyze/AnalyzeApp';

export default async function AnalyzePage(props: {
  searchParams: Promise<{ run?: string | string[] }>;
}) {
  const search = await props.searchParams;
  const raw = Array.isArray(search.run) ? search.run[0] : search.run;
  return <AnalyzeApp initialRunId={raw ?? null} />;
}
