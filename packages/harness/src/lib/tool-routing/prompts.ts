import type { ToolDefinition, ToolRoutingCondition, ToolRoutingTask } from './types';

/**
 * Ask for thinking off where the chat template offers the switch.
 *
 * It lives here because `chat_template_kwargs` rewrites the rendered prompt; it
 * is a prompt setting wearing a request field. Harmless on servers that ignore
 * the key, and a no-op on models like LFM2.5-2.6B whose template opens a
 * `<think>` block unconditionally: those are scored on the answer behind the
 * trace instead.
 */
export const THINKING_OFF_EXTRA_BODY: Record<string, unknown> = {
  chat_template_kwargs: { enable_thinking: false },
};

function toolsBlock(tools: ToolDefinition[]): string {
  return tools
    .map(
      (t) =>
        `- ${t.name}: ${t.description}\n  parameters: ${JSON.stringify(t.parameters)}`,
    )
    .join('\n');
}

const CONTRACT = `Respond with exactly one JSON object and nothing else.
If you can call a tool, use: {"tool":"<name>","arguments":{...}}
If no tool applies, use: {"action":"BLOCK"}
If a required argument is missing and you cannot invent it, use: {"action":"DEFER"}`;

/**
 * Build the user prompt for one condition.
 * - bare: tool definitions only
 * - contract: the same prompt with the JSON contract spelled out
 */
export function buildToolRoutingPrompt(params: {
  condition: ToolRoutingCondition;
  user: string;
  tools: ToolDefinition[];
}): string {
  const header = `You are a tool router. Available tools:\n${toolsBlock(params.tools)}`;
  if (params.condition === 'bare') {
    return `${header}\n\nUser:\n${params.user}`;
  }
  return `${header}\n\n${CONTRACT}\n\nUser:\n${params.user}`;
}

function signature(tool: ToolDefinition): string {
  const params = tool.parameters as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const required = new Set(params.required ?? []);
  const names = Object.keys(params.properties ?? {}).map((n) =>
    required.has(n) ? n : `${n}?`,
  );
  return `${tool.name}(${names.join(', ')})`;
}

/**
 * What a person reads when voting on one tool-routing task.
 *
 * The full prompt the model saw is a page of JSON schemas, which nobody will
 * read on a ballot; the request and the tool signatures are the part a vote
 * turns on. No instructions and no expected answer: the first would need
 * translating and the second would turn the vote into a lookup.
 */
export function toolRoutingBallotText(task: ToolRoutingTask): string {
  return `${task.user}\n\nTools: ${task.tools.map(signature).join(' · ')}`;
}
