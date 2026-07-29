import type { DatasetTask } from '../../config/datasets';
import type { Demo } from '../optimizer/types';

export interface BuildEvalPromptOptions {
  /** Evolved system/user instruction prepended to the task template */
  instruction?: string;
  demos?: Demo[];
}

/** Build the user prompt for a dataset task. */
export function buildEvalPrompt(
  task: DatasetTask,
  input: string,
  options?: BuildEvalPromptOptions,
): string {
  const parts: string[] = [];

  if (options?.instruction?.trim()) {
    parts.push(options.instruction.trim(), '');
  }

  if (options?.demos?.length) {
    parts.push('Examples:');
    for (const d of options.demos) {
      parts.push(`Input: ${d.input}`);
      parts.push(`Output: ${d.output}`);
      parts.push('');
    }
  }

  switch (task) {
    case 'translation':
      parts.push(
        'Translate the following Hindi text into English.',
        'Reply with only the translation — no quotes, no commentary.',
        '',
        input,
      );
      break;
    case 'classification':
      parts.push(
        'Classify the sentiment of this Hindi movie review.',
        'Labels: 0 = negative, 1 = neutral, 2 = positive.',
        'Reply with only the single digit 0, 1, or 2.',
        '',
        input,
      );
      break;
    case 'math':
      parts.push(
        'Solve the grade-school math word problem.',
        'Show brief reasoning if useful.',
        'End with the final numeric answer on its own line as: #### <number>',
        '',
        input,
      );
      break;
    default: {
      const _exhaustive: never = task;
      throw new Error(`Unknown task: ${_exhaustive}`);
    }
  }

  return parts.join('\n');
}

export function maxTokensForTask(task: DatasetTask): number {
  switch (task) {
    case 'translation':
      return 512;
    case 'classification':
      return 16;
    case 'math':
      return 512;
    default: {
      const _exhaustive: never = task;
      throw new Error(`Unknown task: ${_exhaustive}`);
    }
  }
}
