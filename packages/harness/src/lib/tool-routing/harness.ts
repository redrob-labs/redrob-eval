import type { ProviderId } from '../../config/models';
import { callModel } from '../providers';

import { aggregateSlice, scoreToolRoutingExample } from './metrics';
import { parseToolRoutingPrediction } from './parse';
import { buildToolRoutingPrompt, THINKING_OFF_EXTRA_BODY } from './prompts';
import { buildToolRoutingReport } from './report';
import type {
  ToolRoutingCondition,
  ToolRoutingConditionSlice,
  ToolRoutingExampleRecord,
  ToolRoutingExampleScore,
  ToolRoutingLanguage,
  ToolRoutingReport,
  ToolRoutingTask,
} from './types';
import { TOOL_ROUTING_CONDITIONS } from './types';

export type ToolRoutingHarnessProgress = {
  done: number;
  total: number;
  message: string;
};

export interface RunToolRoutingHarnessParams {
  modelId: string;
  hfRepoId?: string | null;
  /** Model name the provider expects (a served alias on vLLM, a slug elsewhere). */
  servedModelId: string;
  providerId?: ProviderId;
  /** Registered host to call, resolved server-side. Defaults to the env var. */
  endpoint?: { baseUrl: string; apiKey?: string | null };
  tasks: ToolRoutingTask[];
  /** Languages represented by tasks and report slices. */
  languages?: ToolRoutingLanguage[];
  /** Conditions to run. Compare passes contract only; defaults preserve legacy callers. */
  conditions?: ToolRoutingCondition[];
  /**
   * Max tokens for the router reply. `null` omits the field and lets the server
   * decide. Defaults to unlimited on vLLM and {@link ROUTER_REPLY_MAX_TOKENS}
   * on hosted providers.
   */
  maxTokens?: number | null;
  onProgress?: (event: ToolRoutingHarnessProgress) => void;
}

/**
 * Hosted-provider ceiling for a router reply that may include a reasoning
 * trace. Local (vLLM) runs omit `max_tokens` entirely: a finite cap was
 * measuring the budget, not the model, once LFM2.5 spent it inside `<think>`.
 * Hosted APIs keep a number because an unbounded call there is a bill.
 */
export const ROUTER_REPLY_MAX_TOKENS = 2048;

function defaultMaxTokens(
  providerId: ProviderId,
  override: number | null | undefined,
): number | null {
  if (override !== undefined) return override;
  return providerId === 'vllm' ? null : ROUTER_REPLY_MAX_TOKENS;
}

/**
 * Run the same tasks under bare and contract.
 * Primary output is per-language condition slices + deltas in the report.
 *
 * CPU latency is always null.
 */
export async function runToolRoutingHarness(
  params: RunToolRoutingHarnessParams,
): Promise<ToolRoutingReport> {
  const providerId = params.providerId ?? 'vllm';
  const conditions = params.conditions ?? [...TOOL_ROUTING_CONDITIONS];
  const languages =
    params.languages ??
    [...new Set(params.tasks.map((task) => task.language))];
  const byLangCond = new Map<string, ToolRoutingExampleScore[]>();

  const key = (language: ToolRoutingLanguage, condition: ToolRoutingCondition) =>
    `${language}|${condition}`;

  for (const language of languages) {
    for (const condition of conditions) {
      byLangCond.set(key(language, condition), []);
    }
  }

  const total = params.tasks.length * conditions.length;
  let done = 0;
  const examples: ToolRoutingExampleRecord[] = [];

  for (const task of params.tasks) {
    for (const condition of conditions) {
      params.onProgress?.({
        done,
        total,
        message: `${params.modelId} ${condition} ${task.id}`,
      });
      const prompt = buildToolRoutingPrompt({
        condition,
        user: task.user,
        tools: task.tools,
      });

      const extraBody: Record<string, unknown> = { ...THINKING_OFF_EXTRA_BODY };

      let latencyGpuMs: number | null = null;
      let callError: string | undefined;
      let prediction;
      try {
        const result = await callModel(providerId, params.servedModelId, prompt, {
          temperature: 0,
          maxTokens: defaultMaxTokens(providerId, params.maxTokens),
          extraBody,
          endpoint: params.endpoint,
        });
        latencyGpuMs = result.latencyMs;
        prediction = parseToolRoutingPrediction(result.text);
      } catch (error) {
        callError = error instanceof Error ? error.message : String(error);
        prediction = { kind: 'parse_error' as const, raw: '', message: callError };
      }

      const score = scoreToolRoutingExample({
        expected: task.expected,
        prediction,
        latencyGpuMs,
      });
      byLangCond.get(key(task.language, condition))!.push(score);
      examples.push({
        taskId: task.id,
        language: task.language,
        condition,
        toolset: task.toolset,
        prompt,
        expected: task.expected,
        raw: prediction.raw,
        parsed: prediction,
        score,
        error: callError,
      });
      done += 1;
      params.onProgress?.({
        done,
        total,
        message: `${params.modelId} ${condition} ${task.id}`,
      });
    }
  }

  const slices: ToolRoutingConditionSlice[] = [];
  for (const language of languages) {
    for (const condition of conditions) {
      slices.push(
        aggregateSlice({
          condition,
          language,
          scores: byLangCond.get(key(language, condition)) ?? [],
        }),
      );
    }
  }

  return buildToolRoutingReport({
    modelId: params.modelId,
    hfRepoId: params.hfRepoId,
    languages,
    conditions,
    slices,
    examples,
  });
}
