import type { ToolDefinition, ToolRoutingTask, ToolsetId } from './types';
import { TOOL_ROUTING_LANGUAGES } from './types';

/**
 * Fixture integrity for the tool-routing set.
 *
 * A routing task is only a fair test when its ground truth is answerable from
 * the prompt. The score that turns on this is `argExactMatch`: if the expected
 * arguments name a value the request never gave, no model can produce it, and
 * the task quietly caps every model's argument accuracy below 100% for a reason
 * that is the fixture's fault rather than the model's.
 *
 * So the check that matters is verbatim presence. The tool schemas already say
 * which arguments are copied straight from the request - their descriptions
 * carry "verbatim" or "exactly as written" - and those, and only those, must
 * appear in the user text. City names ("in English"), ISO dates, language
 * codes and the like are normalized, not copied, so requiring them verbatim
 * would be wrong.
 */

const VERBATIM_MARKERS = ['verbatim', 'exactly as written'];

interface CatalogParam {
  type: string;
  description?: string;
}

interface ToolSchema {
  properties: Record<string, CatalogParam>;
  required: string[];
}

function schemaOf(tool: ToolDefinition): ToolSchema {
  const params = tool.parameters as {
    properties?: Record<string, CatalogParam>;
    required?: string[];
  };
  return { properties: params.properties ?? {}, required: params.required ?? [] };
}

/** Arguments the schema says are copied straight from the request. */
export function verbatimArgNames(tool: ToolDefinition): string[] {
  const { properties } = schemaOf(tool);
  return Object.entries(properties)
    .filter(([, p]) => {
      const desc = (p.description ?? '').toLowerCase();
      return VERBATIM_MARKERS.some((marker) => desc.includes(marker));
    })
    .map(([name]) => name);
}

export interface TaskProblem {
  taskId: string;
  message: string;
}

/**
 * Check every task against the toolsets it will be offered. Returns one problem
 * per violation rather than throwing, so a caller can print them all at once.
 */
export function validateToolRoutingTasks(
  tasks: ToolRoutingTask[],
  toolsets: Record<ToolsetId, ToolDefinition[]>,
): TaskProblem[] {
  const problems: TaskProblem[] = [];
  const seen = new Set<string>();
  const add = (taskId: string, message: string) => problems.push({ taskId, message });

  for (const task of tasks) {
    if (!task.id) {
      add('(missing id)', 'task has no id');
      continue;
    }
    if (seen.has(task.id)) add(task.id, 'duplicate id');
    seen.add(task.id);

    if (!TOOL_ROUTING_LANGUAGES.includes(task.language)) {
      add(task.id, `unknown language "${task.language}"`);
    }
    if (!task.user || !task.user.trim()) {
      add(task.id, 'empty user request');
    }

    const offered = toolsets[task.toolset];
    if (!offered) {
      add(task.id, `unknown toolset "${task.toolset}"`);
      continue;
    }

    const expected = task.expected;
    if (expected.kind === 'absence') {
      if (expected.action !== 'BLOCK' && expected.action !== 'DEFER') {
        add(task.id, `absence action must be BLOCK or DEFER, got "${expected.action}"`);
      }
      continue;
    }

    // expected call. Held in a const so its narrowed type survives the closure
    // below - TypeScript will not narrow task.expected inside a callback.
    const tool = offered.find((t) => t.name === expected.tool);
    if (!tool) {
      add(
        task.id,
        `expected tool "${expected.tool}" is not in the "${task.toolset}" toolset it will be offered`,
      );
      continue;
    }

    const { required } = schemaOf(tool);
    const argKeys = Object.keys(expected.arguments);
    const missing = required.filter((name) => !argKeys.includes(name));
    const extra = argKeys.filter((name) => !required.includes(name));
    if (missing.length) add(task.id, `missing required argument(s): ${missing.join(', ')}`);
    if (extra.length) add(task.id, `argument(s) not in ${tool.name}'s schema: ${extra.join(', ')}`);

    for (const name of verbatimArgNames(tool)) {
      const value = expected.arguments[name];
      if (typeof value !== 'string') continue;
      if (!task.user.includes(value)) {
        add(
          task.id,
          `${tool.name}.${name} is copied verbatim, but "${value}" does not appear in the request`,
        );
      }
    }
  }

  return problems;
}
