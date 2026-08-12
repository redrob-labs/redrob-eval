import { NextResponse } from 'next/server';
import {
  listToolRoutingModels,
  loadStubToolRoutingTasks,
  loadStubToolsets,
  TOOL_ROUTING_DEFAULT_LANGUAGES,
  TOOL_ROUTING_LANGUAGES,
  type ToolRoutingModel,
} from '@redrob/harness';
import { listProviders } from '@redrob/harness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/tool-routing/models
 * Registry + stub task counts. eval_only models are listed but flagged.
 */
export async function GET() {
  const includeEvalOnly = true;
  const models: ToolRoutingModel[] = listToolRoutingModels({ includeEvalOnly });
  const tasks = loadStubToolRoutingTasks();
  const byLang: Record<string, number> = {};
  const byToolset: Record<string, number> = {};
  const byLanguageToolset: Record<string, Record<string, number>> = {};
  for (const t of tasks) {
    byLang[t.language] = (byLang[t.language] ?? 0) + 1;
    byToolset[t.toolset] = (byToolset[t.toolset] ?? 0) + 1;
    byLanguageToolset[t.language] ??= {};
    byLanguageToolset[t.language]![t.toolset] =
      (byLanguageToolset[t.language]![t.toolset] ?? 0) + 1;
  }
  const toolsets = loadStubToolsets();

  const providers = listProviders();
  const vllm = providers.find((p) => p.id === 'vllm');

  return NextResponse.json({
    models,
    defaultModelIds: models.filter((m) => m.usable === true).map((m) => m.id),
    languages: TOOL_ROUTING_LANGUAGES,
    defaultLanguages: TOOL_ROUTING_DEFAULT_LANGUAGES,
    stubTasks: { total: tasks.length, byLanguage: byLang, byToolset, byLanguageToolset },
    toolsets: {
      core: toolsets.core.length,
      wide: toolsets.wide.length,
      full: toolsets.full.length,
    },
    /** A key exists. Says nothing about any endpoint being up: gate on /api/vllm-hosts/[id]/probe. */
    vllmConfigured: Boolean(vllm?.configured),
  });
}
