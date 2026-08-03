import type { CustomGoalSpec } from '../optimizer/custom-goal';
import { defaultInstructionFromGoal } from '../optimizer/custom-goal';
import type { Example } from '../optimizer/types';
import { promptFingerprint } from './params';

export function preferenceSystemPrompt(task: CustomGoalSpec): string {
  return defaultInstructionFromGoal(task.goal, task.mode);
}

/**
 * User message template (placeholders for fingerprinting).
 * Actual calls substitute {{input}} / {{section}}.
 */
export function preferenceUserTemplate(): string {
  return (
    'Task rubric (for your awareness — produce the best answer to the input):\n' +
    '{{rubric}}\n\n' +
    'Input:\n{{input}}\n\n' +
    '{{sectionBlock}}' +
    'Respond with the complete answer only. Do not mention absolute prices or currency.'
  );
}

export function buildPreferencePrompt(params: {
  task: CustomGoalSpec;
  input: Example;
  sectionIndex?: number;
  sectionText?: string;
}): { system: string; user: string } {
  const system = preferenceSystemPrompt(params.task);
  const sectionBlock =
    params.sectionText != null
      ? `Section ${((params.sectionIndex ?? 0) + 1)} of parallel fan-out:\n${params.sectionText}\n\n`
      : '';
  const user = preferenceUserTemplate()
    .replace('{{rubric}}', params.task.rubric.trim())
    .replace('{{input}}', params.input.input)
    .replace('{{sectionBlock}}', sectionBlock);
  return { system, user };
}

export function preferencePromptFingerprint(task: CustomGoalSpec): string {
  return promptFingerprint(preferenceSystemPrompt(task), preferenceUserTemplate());
}

/** Optional sections from Custom Goal JSONL (`sections` array → Example.meta.sections). */
export function exampleSections(example: Example): string[] | undefined {
  const raw = example.meta?.sections;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: string[] = [];
  for (const s of raw) {
    if (typeof s !== 'string' || !s.trim()) return undefined;
    out.push(s.trim());
  }
  return out.length ? out : undefined;
}
