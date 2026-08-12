/**
 * Custom GEPA goals: user goal + rubric + input-only examples.
 * Checklist / video mode uses QWK by default and keeps reference anchors fixed.
 */
import type { EvalSample } from '../datasets/types';
import { lintChecklistRubric, type RubricLintResult } from './rubric-lint';
import type { Example } from './types';

export const CUSTOM_GOAL_MIN_EXAMPLES = 3;
export const CUSTOM_GOAL_MAX_EXAMPLES = 80;

export type CustomGoalMode = 'text' | 'checklist';

/** Fixed few-shot frame-set anchors (not rewritten by instruction evolution). */
export interface ReferenceAnchor {
  /** e.g. beginner | intermediate | skilled */
  label: string;
  /** Paths to exemplar frames (images), never video bytes */
  framePaths: string[];
}

export interface CustomGoalSpec {
  goal: string;
  rubric: string;
  examples: Example[];
  mode: CustomGoalMode;
  /** Present when mode is checklist — non-optimizable few-shot anchors */
  anchors?: ReferenceAnchor[];
  /** Rubric-shape lint (warnings only) */
  rubricLint: RubricLintResult;
}

export interface CustomGoalInput {
  goal: string;
  rubric: string;
  examplesRaw: string;
  /** Tag checklist/video skill scoring; defaults metric to qwk */
  mode?: CustomGoalMode;
  anchors?: ReferenceAnchor[];
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
    const gold =
      typeof rec.gold === 'string'
        ? rec.gold
        : typeof rec.label === 'string'
          ? rec.label
          : '';
    const meta: Record<string, unknown> = {};
    if (Array.isArray(rec.sections)) {
      const sections = rec.sections
        .filter((s): s is string => typeof s === 'string' && Boolean(s.trim()))
        .map((s) => s.trim());
      if (sections.length > 0) meta.sections = sections;
    }
    examples.push({
      id,
      input,
      gold,
      split: undefined,
      meta: Object.keys(meta).length ? meta : undefined,
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

function normalizeAnchors(raw: ReferenceAnchor[] | undefined): ReferenceAnchor[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  if (raw.length < 2 || raw.length > 3) {
    throw new Error('Checklist reference anchors must be 2-3 labeled frame-sets');
  }
  return raw.map((a, i) => {
    const label = a.label?.trim();
    if (!label) throw new Error(`Anchor ${i + 1} needs a label`);
    if (!Array.isArray(a.framePaths) || a.framePaths.length === 0) {
      throw new Error(`Anchor "${label}" needs non-empty framePaths`);
    }
    return { label, framePaths: [...a.framePaths] };
  });
}

export function buildCustomGoalSpec(input: CustomGoalInput): CustomGoalSpec {
  const goal = input.goal.trim();
  const rubric = input.rubric.trim();
  if (!goal) throw new Error('Goal is required');
  if (!rubric) throw new Error('Rubric is required');
  if (goal.length > 4000) throw new Error('Goal is too long (max 4000 chars)');
  if (rubric.length > 8000) throw new Error('Rubric is too long (max 8000 chars)');
  const mode: CustomGoalMode = input.mode === 'checklist' ? 'checklist' : 'text';
  const rubricLint = lintChecklistRubric(`${goal}\n${rubric}`);
  const anchors = mode === 'checklist' ? normalizeAnchors(input.anchors) : undefined;
  return {
    goal,
    rubric,
    examples: parseCustomExamples(input.examplesRaw),
    mode,
    anchors,
    rubricLint,
  };
}

export function defaultInstructionFromGoal(goal: string, mode: CustomGoalMode = 'text'): string {
  const g = goal.trim().replace(/\s+/g, ' ');
  const clipped = g.length > 600 ? `${g.slice(0, 600)}…` : g;
  if (mode === 'checklist') {
    return (
      `You score a hands-on skill from sampled frames using ONLY observable binary checklist items.\n` +
      `Goal:\n${clipped}\n\n` +
      `For each item, answer whether the verifiable event occurred (0/1). ` +
      `Do not give holistic 1-10 ratings, causal explanations, or predictions. ` +
      `If lighting/angle/focus make the clip unscorable, reply with ABSTAIN. ` +
      `Do not mention absolute prices or dollar costs.`
    );
  }
  return (
    `You help with the following goal:\n${clipped}\n\n` +
    `Produce a clear, complete response for each input. ` +
    `Do not mention absolute prices or dollar costs.`
  );
}

/**
 * Append fixed reference-anchor prose to an instruction without letting GEPA drop it.
 * Callers should use this as a prompt-time suffix, not mutate Candidate.instruction anchors away.
 */
export function appendAnchorBlock(
  instruction: string,
  anchors: ReferenceAnchor[] | undefined,
): string {
  if (!anchors || anchors.length === 0) return instruction;
  const lines = [
    instruction.trim(),
    '',
    '## Reference anchors (fixed, do not omit; judge relatively against these)',
    ...anchors.map(
      (a) =>
        `- ${a.label}: ${a.framePaths.length} exemplar frame(s)` +
        (a.framePaths[0] ? ` (e.g. ${a.framePaths[0]})` : ''),
    ),
  ];
  return lines.join('\n');
}

export function customGoalToLoadedDataset(spec: CustomGoalSpec): {
  datasetId: string;
  label: string;
  task: 'custom' | 'checklist';
  metric: 'llm_judge' | 'qwk';
  samples: EvalSample[];
  hfDataset: string;
  hfConfig: string;
  hfSplit: string;
  seed: number;
  maxSamples: number;
  fromCache: boolean;
  license: string;
} {
  const isChecklist = spec.mode === 'checklist';
  return {
    datasetId: isChecklist ? 'custom-checklist' : 'custom-goal',
    label: isChecklist ? 'Custom checklist / video skill' : 'Custom goal',
    task: isChecklist ? 'checklist' : 'custom',
    metric: isChecklist ? 'qwk' : 'llm_judge',
    samples: spec.examples.map((e) => ({
      id: e.id,
      input: e.input,
      gold: e.gold ?? '',
      meta: e.meta,
    })),
    hfDataset: isChecklist ? 'local/custom-checklist' : 'local/custom-goal',
    hfConfig: 'default',
    hfSplit: 'all',
    seed: 42,
    maxSamples: spec.examples.length,
    fromCache: true,
    license: 'user-provided',
  };
}
