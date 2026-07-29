import type { ProviderId } from '../../../config/models';
import { callModel } from '../../providers';
import {
  SCRIPT_POLICIES,
  defaultScriptBundle,
  type ScriptPolicy,
  type ScriptPolicyBundle,
} from '../../script-policy';
import type { Candidate, Demo, ModelGene, ReflectiveRecord } from '../types';
import { newCandidateId, resolveScriptPolicies } from '../types';
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

  const meta = [
    'You are optimizing an LLM program for Indian-language / Indic-aware tasks.',
    'Given the current instruction, ancestor lessons, and Actionable Side Information',
    '(diagnostic feedback from failed cases), propose an improved instruction.',
    'Consider script_policy: native | romanize | normalize_to_native | passthrough.',
    'Apply policies independently to instruction, demos, and user input when useful.',
    'Do NOT mention absolute prices or dollar costs.',
    '',
    'Return ONLY a JSON object:',
    '{"lesson":"<one sentence diagnosis>","instruction":"<full improved instruction>",',
    '"demoCount":<0-4 integer how many demos to request>,',
    '"scriptPolicies":{"instruction":"<policy>","demos":"<policy>","input":"<policy>"}}',
    '',
    '## Current instruction',
    params.parent.instruction || '(empty)',
    '',
    '## Current script_policies',
    JSON.stringify(parentPolicies),
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

  try {
    const result = await callModel(
      params.reflectModel.providerId,
      params.reflectModel.modelId,
      meta,
      { maxTokens: 900, temperature: 0.4 },
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
    } else if (result.text.trim().length > 20) {
      instruction = result.text.trim().slice(0, 2000);
      lesson = 'Reflector returned non-JSON; used text as instruction.';
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

  const demos = pickDemos(params.demoPool, demoCount, params.rand, params.parent.demos);
  const model = maybeSwapModel(params.parent.model, params.modelCatalog, params.rand);

  const child: Candidate = {
    id: newCandidateId('mut'),
    instruction,
    demos,
    model,
    scriptPolicy: scriptPolicies.instruction,
    scriptPolicies,
    maxPromptTokens: params.parent.maxPromptTokens ?? null,
    demosRequested: demoCount,
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
