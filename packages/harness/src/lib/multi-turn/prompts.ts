import type { ToolDefinition } from '../tool-routing/types';

/**
 * How a tool conversation is carried.
 *
 * Tools are described in the prompt and calls come back as one JSON object,
 * the same contract the single-turn tool-routing harness uses. The native
 * `tools` / `tool_calls` fields would be the other option, and they are not
 * used here for the reason the contract exists at all: they are not available
 * everywhere. A self-hosted model behind vLLM, a hosted API and a small local
 * model have to be able to sit the same exam, and half of them cannot enter
 * one that requires provider-side function calling.
 *
 * What that costs is worth stating: this measures whether a model can follow a
 * tool protocol described in text, not whether it drives a provider's function
 * calling API. Those are different things and a good score here is not a claim
 * about the other.
 */
const TOOL_CONTRACT = `When you need a tool, reply with exactly one JSON object and nothing else:
{"tool":"<name>","arguments":{...}}
When no tool applies, reply with {"action":"BLOCK"}.
When a required argument is missing and you cannot invent it, reply with {"action":"DEFER"}.
When you already have what you need - including from a tool result earlier in this
conversation - answer the user in plain language instead of calling anything.`;

function toolsBlock(tools: ToolDefinition[]): string {
  return tools
    .map((t) => `- ${t.name}: ${t.description}\n  parameters: ${JSON.stringify(t.parameters)}`)
    .join('\n');
}

/**
 * The system prompt for one scenario.
 *
 * A tool scenario needs the toolset and the contract on every turn, and the
 * system prompt is the one place that survives the whole conversation without
 * being repeated into the transcript the model has to re-read each turn.
 */
export function buildSystemPrompt(scenario: {
  kind: 'text' | 'tool';
  system?: string;
  tools?: ToolDefinition[];
}): string | undefined {
  const parts: string[] = [];
  if (scenario.system?.trim()) parts.push(scenario.system.trim());
  if (scenario.kind === 'tool' && scenario.tools?.length) {
    parts.push(`Available tools:\n${toolsBlock(scenario.tools)}`);
    parts.push(TOOL_CONTRACT);
  }
  return parts.length ? parts.join('\n\n') : undefined;
}

/**
 * A tool's answer, framed so the model can tell it from something the user
 * said. It arrives as a user turn because that is the only inbound role every
 * provider in this repo accepts without native tool calling.
 */
export function formatToolResult(tool: string, result: unknown): string {
  return `TOOL RESULT for ${tool}:\n${JSON.stringify(result)}`;
}
