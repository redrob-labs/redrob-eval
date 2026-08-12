import { delta } from './metrics';
import type {
  ToolRoutingConditionDelta,
  ToolRoutingCondition,
  ToolRoutingConditionSlice,
  ToolRoutingLanguage,
  ToolRoutingReport,
} from './types';
import { TOOL_ROUTING_CONDITIONS } from './types';

function findSlice(
  slices: ToolRoutingConditionSlice[],
  language: ToolRoutingLanguage,
  condition: ToolRoutingConditionSlice['condition'],
): ToolRoutingConditionSlice | undefined {
  return slices.find((s) => s.language === language && s.condition === condition);
}

export function buildConditionDeltas(
  slices: ToolRoutingConditionSlice[],
  languages = [...new Set(slices.map((slice) => slice.language))],
): ToolRoutingConditionDelta[] {
  return languages.map((language) => {
    const bare = findSlice(slices, language, 'bare');
    const contract = findSlice(slices, language, 'contract');

    const pair = (
      a: ToolRoutingConditionSlice | undefined,
      b: ToolRoutingConditionSlice | undefined,
    ) => ({
      toolSelectAccuracy: delta(a?.toolSelectAccuracy ?? null, b?.toolSelectAccuracy ?? null),
      argExactMatchAccuracy: delta(
        a?.argExactMatchAccuracy ?? null,
        b?.argExactMatchAccuracy ?? null,
      ),
      absenceAccuracy: delta(a?.absenceAccuracy ?? null, b?.absenceAccuracy ?? null),
      parseFailureRate:
        a && b ? delta(a.parseFailureRate, b.parseFailureRate) : null,
    });

    return { language, contractMinusBare: pair(contract, bare) };
  });
}

export function buildToolRoutingReport(params: {
  modelId: string;
  hfRepoId?: string | null;
  languages?: ToolRoutingLanguage[];
  conditions?: ToolRoutingCondition[];
  slices: ToolRoutingConditionSlice[];
  examples?: ToolRoutingReport['examples'];
  fertility?: ToolRoutingReport['fertility'];
  skipped?: { reason: string }[];
  createdAt?: string;
}): ToolRoutingReport {
  const languages =
    params.languages ?? [...new Set(params.slices.map((slice) => slice.language))];
  const conditions =
    params.conditions ?? [...new Set(params.slices.map((slice) => slice.condition))];
  const hasDeltaPair = conditions.includes('bare') && conditions.includes('contract');
  return {
    schema: 'redrob-tool-routing/v2',
    createdAt: params.createdAt ?? new Date().toISOString(),
    modelId: params.modelId,
    hfRepoId: params.hfRepoId ?? null,
    languageConstraints: [...languages],
    conditions: conditions.length ? [...conditions] : [...TOOL_ROUTING_CONDITIONS],
    slices: params.slices,
    deltas: hasDeltaPair ? buildConditionDeltas(params.slices, languages) : [],
    examples: params.examples,
    fertility: params.fertility,
    skipped: params.skipped,
  };
}
