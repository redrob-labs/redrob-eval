/**
 * Multi-turn evaluation.
 *
 * Single-turn scoring asks whether a model can answer. A conversation asks
 * something the single-turn harnesses cannot: whether it still holds, at turn
 * four, what it was told at turn one - the constraint, the correction, and the
 * result a tool handed back two turns ago.
 *
 * The user side is scripted. Every model sees the same words in the same order,
 * so a difference in the transcript is a difference in the model rather than in
 * how the conversation went. The cost is that no model can steer the dialogue,
 * which is exactly the property that makes the runs comparable.
 */

import type { ToolDefinition } from '../tool-routing/types';

export type MultiTurnLanguage = 'en' | 'ko';

/**
 * What each turn is there to find out. Reported per capability, because "68%
 * of turns passed" says nothing about whether the failures were forgotten
 * constraints or bungled tool calls.
 */
export type MultiTurnCapability =
  /** Holds an instruction given earlier and not repeated. */
  | 'instruction_retention'
  /** Uses a fact the user stated in an earlier turn. */
  | 'context_recall'
  /** Takes back what it said when the user corrects a detail. */
  | 'correction'
  /** Emits the right call, with the right arguments, at the right turn. */
  | 'tool_call'
  /** Answers from the tool result already in the transcript. */
  | 'tool_use_result'
  /** Declines instead of inventing, when no tool can serve the request. */
  | 'tool_absence';

/** One thing a reply has to do. Every check on a turn has to hold. */
export type TurnCheck =
  | { kind: 'contains'; text: string }
  | { kind: 'absent'; text: string }
  | { kind: 'regex'; pattern: string; flags?: string }
  | { kind: 'tool_call'; tool: string; arguments?: Record<string, unknown> }
  | { kind: 'absence'; action: 'BLOCK' | 'DEFER' }
  /** The answer is in the transcript already; calling again is the failure. */
  | { kind: 'no_tool_call' };

export interface ScriptedTurn {
  /**
   * What the user says. Omitted when the turn exists only to hand back a tool
   * result and read what the model does with it.
   */
  user?: string;
  /**
   * The tool's answer, delivered before this turn's call.
   *
   * Canned, never executed: a harness that ran real tools would be measuring
   * the weather service too, and could not be replayed a month later.
   */
  toolResult?: { tool: string; result: unknown };
  capability: MultiTurnCapability;
  expect: TurnCheck[];
}

export interface MultiTurnScenario {
  id: string;
  language: MultiTurnLanguage;
  /** `tool` scenarios offer a toolset and score the JSON contract. */
  kind: 'text' | 'tool';
  /** What the scenario is for, in one line. Not sent to the model. */
  about: string;
  system?: string;
  /** Named tools offered on every turn of a `tool` scenario. */
  toolNames?: string[];
  turns: ScriptedTurn[];
}

/** A scenario with its tool definitions resolved. */
export interface LoadedScenario extends MultiTurnScenario {
  tools: ToolDefinition[];
}

export interface TurnCheckResult {
  check: TurnCheck;
  passed: boolean;
  /** Why it failed, in the terms of the check. Empty when it passed. */
  detail: string;
}

export interface TurnRecord {
  index: number;
  capability: MultiTurnCapability;
  /** Exactly what the user side said this turn, tool result included. */
  sent: string;
  /** Exactly what came back, before any parsing. */
  reply: string;
  checks: TurnCheckResult[];
  passed: boolean;
  latencyMs: number | null;
  /** Set when the provider call threw, as opposed to answering something wrong. */
  error?: string;
  /**
   * The turn expected a tool result to follow a call that never happened. The
   * result is still delivered so the rest of the scenario runs, but this turn
   * and the conversation after it are reading a transcript the model did not
   * produce.
   */
  desynced?: boolean;
}

export interface ScenarioRecord {
  scenarioId: string;
  language: MultiTurnLanguage;
  kind: 'text' | 'tool';
  turns: TurnRecord[];
  passed: boolean;
  /** First turn that failed, 1-based; null when the whole scenario held. */
  firstFailedTurn: number | null;
}

export interface CapabilitySlice {
  capability: MultiTurnCapability;
  turns: number;
  passed: number;
  passRate: number;
}

/** Pass rate at each depth, which is the question depth was added to answer. */
export interface DepthSlice {
  /** 1-based turn position within the scenario. */
  turn: number;
  turns: number;
  passed: number;
  passRate: number;
}

export interface MultiTurnReport {
  schema: 'redrob-multi-turn/v1';
  createdAt: string;
  modelId: string;
  languages: MultiTurnLanguage[];
  scenarios: ScenarioRecord[];
  scenariosPassed: number;
  scenarioPassRate: number;
  turnsPassed: number;
  turnPassRate: number;
  byCapability: CapabilitySlice[];
  byDepth: DepthSlice[];
  /** Turns where the provider call itself failed, so nothing was scored. */
  callErrors: number;
  latencyMs: { p50: number | null; p95: number | null };
}
