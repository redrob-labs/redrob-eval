import type { ProviderId } from '../../config/models';
import { callModel } from '../providers';
import type { ChatTurn } from '../providers/types';

import { calledTool, runChecks } from './checks';
import { buildMultiTurnReport } from './metrics';
import { buildSystemPrompt, formatToolResult } from './prompts';
import type {
  LoadedScenario,
  MultiTurnLanguage,
  MultiTurnReport,
  ScenarioRecord,
  TurnRecord,
} from './types';

/** A conversation is many calls; a runaway reply in one of them pays for all of them. */
export const MULTI_TURN_MAX_TOKENS = 1024;

export interface MultiTurnProgress {
  done: number;
  total: number;
  message: string;
}

/** The one thing the runner needs from the outside, so tests can script it. */
export type MultiTurnCaller = (params: {
  systemPrompt?: string;
  history: ChatTurn[];
  prompt: string;
}) => Promise<{ text: string; latencyMs: number }>;

export interface RunMultiTurnParams {
  modelId: string;
  /** Name the provider expects; a served alias on vLLM, a slug elsewhere. */
  servedModelId?: string;
  providerId?: ProviderId;
  endpoint?: { baseUrl: string; apiKey?: string | null };
  scenarios: LoadedScenario[];
  maxTokens?: number | null;
  onProgress?: (event: MultiTurnProgress) => void;
  /** Overrides the provider call. Offline checks pass a scripted one. */
  caller?: MultiTurnCaller;
}

function providerCaller(params: RunMultiTurnParams): MultiTurnCaller {
  const providerId = params.providerId ?? 'vllm';
  const servedModelId = params.servedModelId ?? params.modelId;
  return async ({ systemPrompt, history, prompt }) => {
    const result = await callModel(providerId, servedModelId, prompt, {
      systemPrompt,
      history,
      temperature: 0,
      maxTokens: params.maxTokens === undefined ? MULTI_TURN_MAX_TOKENS : params.maxTokens,
      endpoint: params.endpoint,
    });
    return { text: result.text, latencyMs: result.latencyMs };
  };
}

/**
 * Walk one scenario, turn by turn, and score each reply as it comes.
 *
 * The transcript is built from what actually happened: the model's own replies
 * go back in verbatim, so a model that answered badly at turn two is reading
 * its own bad answer at turn three, which is the situation being measured.
 *
 * A turn that expected a tool call and did not get one is marked `desynced`.
 * The canned result is delivered anyway rather than abandoning the scenario:
 * the later turns still say something about the model, as long as the report
 * is honest that the conversation stopped being one the model produced.
 */
export async function runScenario(
  scenario: LoadedScenario,
  call: MultiTurnCaller,
): Promise<ScenarioRecord> {
  const systemPrompt = buildSystemPrompt(scenario);
  const history: ChatTurn[] = [];
  const turns: TurnRecord[] = [];
  let lastReply = '';

  for (const [index, turn] of scenario.turns.entries()) {
    const parts: string[] = [];
    let desynced = false;

    if (turn.toolResult) {
      // Only a call the model actually made can be answered. Saying otherwise
      // would hand it a result for a question it never asked.
      if (!calledTool(lastReply, turn.toolResult.tool)) desynced = true;
      parts.push(formatToolResult(turn.toolResult.tool, turn.toolResult.result));
    }
    if (turn.user) parts.push(turn.user);
    const sent = parts.join('\n\n');

    let reply = '';
    let latencyMs: number | null = null;
    let error: string | undefined;
    try {
      const answered = await call({ systemPrompt, history: [...history], prompt: sent });
      reply = answered.text;
      latencyMs = answered.latencyMs;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    const checks = error ? [] : runChecks(turn.expect, reply);
    turns.push({
      index: index + 1,
      capability: turn.capability,
      sent,
      reply,
      checks,
      // A call that never answered is a failed turn, not a passed one with no
      // checks: an empty check list would otherwise read as "everything held".
      passed: !error && !desynced && checks.every((c) => c.passed),
      latencyMs,
      error,
      desynced: desynced || undefined,
    });

    history.push({ role: 'user', content: sent });
    history.push({ role: 'assistant', content: reply });
    lastReply = reply;
  }

  const firstFailed = turns.find((t) => !t.passed);
  return {
    scenarioId: scenario.id,
    language: scenario.language,
    kind: scenario.kind,
    turns,
    passed: !firstFailed,
    firstFailedTurn: firstFailed?.index ?? null,
  };
}

/** Run every scenario against one model and roll the transcripts into a report. */
export async function runMultiTurnHarness(
  params: RunMultiTurnParams,
): Promise<MultiTurnReport> {
  const call = params.caller ?? providerCaller(params);
  const total = params.scenarios.reduce((sum, s) => sum + s.turns.length, 0);
  const records: ScenarioRecord[] = [];
  let done = 0;

  for (const scenario of params.scenarios) {
    params.onProgress?.({ done, total, message: `${params.modelId} ${scenario.id}` });
    const record = await runScenario(scenario, call);
    records.push(record);
    done += scenario.turns.length;
    params.onProgress?.({ done, total, message: `${params.modelId} ${scenario.id}` });
  }

  const languages = [
    ...new Set(params.scenarios.map((s) => s.language)),
  ] as MultiTurnLanguage[];
  return buildMultiTurnReport({ modelId: params.modelId, languages, scenarios: records });
}
