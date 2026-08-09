import type { ProviderId } from '../../../config/models';
import {
  FRAME_COUNTS,
  FRAME_SAMPLE_STRATEGIES,
  TOKENS_PER_FRAME,
  defaultFramePolicy,
  parseFramePolicy,
  type FramePolicy,
} from '../../frame-policy';
import { callModel } from '../../providers';
import {
  SCRIPT_POLICIES,
  defaultScriptBundle,
  type ScriptPolicy,
  type ScriptPolicyBundle,
} from '../../script-policy';
import type { Candidate, Demo, ModelGene, ReflectiveRecord } from '../types';
import { newCandidateId, resolveFramePolicy, resolveScriptPolicies } from '../types';
import { prioritizeForReflection } from './make-reflective-dataset';

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1]!.trim() : trimmed;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Recover the instruction from a reply that set out to be JSON and was cut off.
 *
 * The reflector is asked for `{ lesson, instruction, ... }`, and a good instruction is
 * long, so the reply is the one most likely to hit the cap — mid-string, leaving no
 * closing brace for `parseJsonObject` to find. The instruction is nearly always complete
 * enough to use by then; what is missing is the punctuation after it.
 *
 * The capture stops at the first unescaped quote, which is the closing one when the reply
 * survived and the end of the text when it did not. Re-parsing it as a JSON string is
 * what turns `\n` back into newlines, and also what rejects a cut that landed mid-escape.
 */
function salvageInstruction(text: string): string | null {
  const match = text.match(/"instruction"\s*:\s*"((?:[^"\\]|\\.)*)/);
  const body = match?.[1];
  if (!body || body.trim().length < 40) return null;
  try {
    const unescaped = JSON.parse(`"${body}"`) as unknown;
    return typeof unescaped === 'string' && unescaped.trim() ? unescaped.trim() : null;
  } catch {
    return null;
  }
}

/** Did the reflector at least try to answer in JSON? */
function looksLikeJson(text: string): boolean {
  return /^\s*(?:```|\{)/.test(text);
}

/** Exposed for the salvage tests; not part of the module's surface. */
export const __testables = { salvageInstruction, looksLikeJson };

function parseScriptPolicy(v: unknown): ScriptPolicy | null {
  if (typeof v !== 'string') return null;
  return (SCRIPT_POLICIES as string[]).includes(v) ? (v as ScriptPolicy) : null;
}

/**
 * Reflective mutation: LLM reads ASI traces and proposes an improved instruction
 * (+ optional script_policy / demo count).
 */
export async function reflectAndMutate(params: {
  parent: Candidate;
  reflectiveDataset: ReflectiveRecord[];
  lessons: string[];
  reflectModel: { providerId: ProviderId; modelId: string };
  demoPool: Demo[];
  modelCatalog: ModelGene[];
  rand: () => number;
  customGoal?: { goal: string; rubric: string };
}): Promise<{ child: Candidate; lesson: string }> {
  const focused = prioritizeForReflection(params.reflectiveDataset);
  const asiBlock = focused
    .map(
      (r, i) =>
        `### Case ${i + 1} (score=${r.score})\n` +
        `Feedback (ASI): ${r.feedback}\n` +
        `Input: ${r.input.slice(0, 300)}\n` +
        `Gold: ${r.gold.slice(0, 200)}\n` +
        `Prediction: ${r.prediction.slice(0, 300)}\n` +
        `Trace:\n${r.trace.slice(0, 500)}`,
    )
    .join('\n\n');

  const ancestorLessons =
    params.lessons.length > 0
      ? params.lessons.map((l, i) => `${i + 1}. ${l}`).join('\n')
      : '(none yet)';

  const parentPolicies = resolveScriptPolicies(params.parent);

  const goalBlock = params.customGoal
    ? [
        '',
        '## Optimization goal (fixed — do not invent a new goal)',
        params.customGoal.goal,
        '',
        '## Scoring rubric (fixed — improve the instruction so outputs score higher)',
        params.customGoal.rubric,
      ].join('\n')
    : '';

  const parentFrame = params.parent.framePolicy
    ? resolveFramePolicy(params.parent)
    : undefined;

  const meta = [
    'You are optimizing an LLM program for real user tasks (including multilingual / high-fertility tokenizers when relevant)',
    '(and optionally video/checklist skill scoring).',
    'Given the current instruction, ancestor lessons, and Actionable Side Information',
    '(diagnostic feedback from failed cases), propose an improved instruction.',
    'Consider script_policy: native | romanize | normalize_to_native | passthrough.',
    'Apply policies independently to instruction, demos, and user input when useful.',
    'For checklist/video, also consider frame_policy:',
    'strategy=uniform|motion_energy|event_detect; n_frames=4|8|16; tokens_per_frame=256|640|1280.',
    'Do NOT drop fixed reference anchors if present in the instruction.',
    'Do NOT mention absolute prices or dollar costs.',
    '',
    'Return ONLY a JSON object:',
    '{"lesson":"<one sentence diagnosis>","instruction":"<full improved instruction>",',
    '"demoCount":<0-4 integer how many demos to request>,',
    '"scriptPolicies":{"instruction":"<policy>","demos":"<policy>","input":"<policy>"},',
    '"framePolicy":{"strategy":"<s>","n_frames":<n>,"tokens_per_frame":<t>}}',
    '',
    '## Current instruction',
    params.parent.instruction || '(empty)',
    '',
    '## Current script_policies',
    JSON.stringify(parentPolicies),
    '',
    '## Current frame_policy',
    parentFrame ? JSON.stringify(parentFrame) : '(none — text-only candidate)',
    goalBlock,
    '',
    '## Ancestor lessons',
    ancestorLessons,
    '',
    '## Actionable Side Information',
    asiBlock || '(no cases)',
  ].join('\n');

  let lesson = 'No reflective update; kept parent instruction.';
  let instruction = params.parent.instruction;
  let demoCount =
    params.parent.demosRequested ?? params.parent.demos.length;
  let scriptPolicies: ScriptPolicyBundle = { ...parentPolicies };
  let framePolicy: FramePolicy | undefined = parentFrame
    ? { ...parentFrame }
    : undefined;

  try {
    const result = await callModel(
      params.reflectModel.providerId,
      params.reflectModel.modelId,
      meta,
      // A lesson plus a full replacement instruction does not fit in 900, and the reply
      // that overflows is the one carrying the improvement.
      { maxTokens: 1800, temperature: 0.4 },
    );
    const parsed = parseJsonObject(result.text);
    if (parsed) {
      if (typeof parsed.lesson === 'string' && parsed.lesson.trim()) {
        lesson = parsed.lesson.trim();
      }
      if (typeof parsed.instruction === 'string' && parsed.instruction.trim()) {
        instruction = parsed.instruction.trim();
      }
      if (typeof parsed.demoCount === 'number' && Number.isFinite(parsed.demoCount)) {
        demoCount = Math.max(0, Math.min(4, Math.floor(parsed.demoCount)));
      }
      if (parsed.scriptPolicies && typeof parsed.scriptPolicies === 'object') {
        const sp = parsed.scriptPolicies as Record<string, unknown>;
        const next = { ...scriptPolicies };
        const i = parseScriptPolicy(sp.instruction);
        const d = parseScriptPolicy(sp.demos);
        const u = parseScriptPolicy(sp.input);
        if (i) next.instruction = i;
        if (d) next.demos = d;
        if (u) next.input = u;
        scriptPolicies = next;
      } else {
        const single = parseScriptPolicy(parsed.scriptPolicy);
        if (single) scriptPolicies = defaultScriptBundle(single);
      }
      const fp = parseFramePolicy(parsed.framePolicy);
      if (fp) framePolicy = fp;
    } else {
      // The old fallback pasted the raw reply in as the instruction. When the reply was a
      // JSON object cut off mid-string — the common case, since the cap lands inside the
      // longest field — that shipped a ```json fence and a "lesson" key into the prompt
      // used by every later rollout, and into the evolved prompt the reader copies out.
      // Seen live: quality still rose, on an instruction wrapped in JSON syntax.
      const salvaged = salvageInstruction(result.text);
      if (salvaged) {
        instruction = salvaged.slice(0, 2000);
        lesson = 'Reflector reply was cut off; recovered the instruction from the partial JSON.';
      } else if (!looksLikeJson(result.text) && result.text.trim().length > 20) {
        instruction = result.text.trim().slice(0, 2000);
        lesson = 'Reflector answered in prose rather than JSON; used it as the instruction.';
      } else {
        lesson = 'Reflector reply was unusable; kept the parent instruction.';
      }
    }
  } catch {
    lesson = 'Reflector call failed; applied light demo/model/script mutation only.';
  }

  // Light stochastic exploration of script policy when reflector omitted it
  if (params.rand() < 0.2) {
    const pick = SCRIPT_POLICIES[Math.floor(params.rand() * SCRIPT_POLICIES.length)]!;
    const part = (['instruction', 'demos', 'input'] as const)[
      Math.floor(params.rand() * 3)
    ]!;
    scriptPolicies = { ...scriptPolicies, [part]: pick };
  }

  // Light stochastic exploration of frame_policy for checklist candidates
  if (framePolicy && params.rand() < 0.2) {
    const next = { ...framePolicy };
    const which = Math.floor(params.rand() * 3);
    if (which === 0) {
      next.strategy =
        FRAME_SAMPLE_STRATEGIES[Math.floor(params.rand() * FRAME_SAMPLE_STRATEGIES.length)]!;
    } else if (which === 1) {
      next.n_frames = FRAME_COUNTS[Math.floor(params.rand() * FRAME_COUNTS.length)]!;
    } else {
      next.tokens_per_frame =
        TOKENS_PER_FRAME[Math.floor(params.rand() * TOKENS_PER_FRAME.length)]!;
    }
    framePolicy = defaultFramePolicy(next);
  }

  const demos = pickDemos(params.demoPool, demoCount, params.rand, params.parent.demos);
  const model = maybeSwapModel(params.parent.model, params.modelCatalog, params.rand);

  const child: Candidate = {
    id: newCandidateId('mut'),
    instruction,
    demos,
    model,
    scriptPolicy: scriptPolicies.instruction,
    scriptPolicies,
    framePolicy,
    maxPromptTokens: params.parent.maxPromptTokens ?? null,
    demosRequested: demoCount,
    framesRequested: framePolicy?.n_frames,
    parentIds: [params.parent.id],
    lessons: [...params.parent.lessons, lesson].slice(-12),
  };

  return { child, lesson };
}

function pickDemos(
  pool: Demo[],
  count: number,
  rand: () => number,
  fallback: Demo[],
): Demo[] {
  const source = pool.length > 0 ? pool : fallback;
  if (count <= 0 || source.length === 0) return [];
  const copy = [...source];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, Math.min(count, copy.length));
}

function maybeSwapModel(
  current: ModelGene,
  catalog: ModelGene[],
  rand: () => number,
): ModelGene {
  if (catalog.length <= 1 || rand() > 0.25) return { ...current };
  const pick = catalog[Math.floor(rand() * catalog.length)]!;
  return { ...pick };
}
