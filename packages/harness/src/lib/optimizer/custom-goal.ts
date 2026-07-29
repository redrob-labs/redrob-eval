/**
 * Custom GEPA goals: user goal + rubric + input-only examples.
 */
import type { EvalSample } from '../datasets/types';
import type { Example } from './types';

export const CUSTOM_GOAL_MIN_EXAMPLES = 3;
export const CUSTOM_GOAL_MAX_EXAMPLES = 80;

export interface CustomGoalSpec {
  goal: string;
  rubric: string;
  examples: Example[];
}

export interface CustomGoalInput {
  goal: string;
  rubric: string;
  examplesRaw: string;
}

/** Parse JSONL or a JSON array of `{ id?, input }` rows. */
export function parseCustomExamples(raw: string): Example[] {
  const text = raw.trim();
  if (!text) throw new Error('Paste at least one example with an "input" field');

  let rows: unknown[];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!Array.isArray(parsed)) throw new Error('Examples JSON must be an array');
      rows = parsed;
    } catch (e) {
      throw new Error(
        e instanceof Error ? `Invalid examples JSON: ${e.message}` : 'Invalid examples JSON',
      );
    }
  } else {
    rows = [];
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      try {
        rows.push(JSON.parse(lines[i]!));
      } catch {
        throw new Error(`Invalid JSONL on line ${i + 1}`);
      }
    }
  }

  const examples: Example[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`Example ${i + 1} must be an object with an "input" string`);
    }
    const rec = row as Record<string, unknown>;
    const input = typeof rec.input === 'string' ? rec.input.trim() : '';
    if (!input) {
      throw new Error(`Example ${i + 1} needs a non-empty "input" string`);
    }
    const id =
      typeof rec.id === 'string' && rec.id.trim()
        ? rec.id.trim()
        : `custom_${i + 1}`;
    examples.push({
      id,
      input,
      gold: '',
      split: undefined,
    });
  }

  if (examples.length < CUSTOM_GOAL_MIN_EXAMPLES) {
    throw new Error(`Need at least ${CUSTOM_GOAL_MIN_EXAMPLES} examples (got ${examples.length})`);
  }
  if (examples.length > CUSTOM_GOAL_MAX_EXAMPLES) {
    throw new Error(
      `At most ${CUSTOM_GOAL_MAX_EXAMPLES} examples (got ${examples.length})`,
    );
  }

  return examples;
}

export function buildCustomGoalSpec(input: CustomGoalInput): CustomGoalSpec {
  const goal = input.goal.trim();
  const rubric = input.rubric.trim();
  if (!goal) throw new Error('Goal is required');
  if (!rubric) throw new Error('Rubric is required');
  if (goal.length > 4000) throw new Error('Goal is too long (max 4000 chars)');
  if (rubric.length > 8000) throw new Error('Rubric is too long (max 8000 chars)');
  return {
    goal,
    rubric,
    examples: parseCustomExamples(input.examplesRaw),
  };
}

export function defaultInstructionFromGoal(goal: string): string {
  const g = goal.trim().replace(/\s+/g, ' ');
  const clipped = g.length > 600 ? `${g.slice(0, 600)}…` : g;
  return (
    `You help with the following goal:\n${clipped}\n\n` +
    `Produce a clear, complete response for each input. ` +
    `Do not mention absolute prices or dollar costs.`
  );
}

export function customGoalToLoadedDataset(spec: CustomGoalSpec): {
  datasetId: string;
  label: string;
  task: 'custom';
  metric: 'llm_judge';
  samples: EvalSample[];
  hfDataset: string;
  hfConfig: string;
  hfSplit: string;
  seed: number;
  maxSamples: number;
  fromCache: boolean;
  license: string;
} {
  return {
    datasetId: 'custom-goal',
    label: 'Custom goal',
    task: 'custom',
    metric: 'llm_judge',
    samples: spec.examples.map((e) => ({
      id: e.id,
      input: e.input,
      gold: e.gold ?? '',
    })),
    hfDataset: 'local/custom-goal',
    hfConfig: 'default',
    hfSplit: 'all',
    seed: 42,
    maxSamples: spec.examples.length,
    fromCache: true,
    license: 'user-provided',
  };
}
