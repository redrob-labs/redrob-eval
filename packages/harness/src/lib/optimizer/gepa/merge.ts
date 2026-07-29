import type { Candidate } from '../types';
import {
  newCandidateId,
  resolveFramePolicy,
  resolveScriptPolicies,
} from '../types';

/**
 * System-aware merge: combine genes from two frontier candidates that excel
 * on different subsets. Prefer the gene that was more recently refined
 * (appears in lessons / is not identical to the shared ancestor defaults).
 */
export function systemAwareMerge(a: Candidate, b: Candidate): Candidate {
  // Instruction: prefer the longer refined instruction if both differ; else A's
  const instruction =
    a.instruction !== b.instruction
      ? a.lessons.length >= b.lessons.length
        ? a.instruction
        : b.instruction
      : a.instruction;

  // Demos: take from the parent with more demos if counts differ; else concatenate unique
  let demos = a.demos;
  if (b.demos.length > a.demos.length) demos = b.demos;
  else if (b.demos.length === a.demos.length && b.demos.length > 0) {
    const seen = new Set(a.demos.map((d) => d.input));
    demos = [...a.demos];
    for (const d of b.demos) {
      if (!seen.has(d.input)) demos.push(d);
    }
    demos = demos.slice(0, 4);
  }

  // Model: prefer lower relative cost weight when both feasible lineages differ
  const model =
    a.model.modelId === b.model.modelId
      ? a.model
      : (a.model.relativeCostWeight ?? 50) <= (b.model.relativeCostWeight ?? 50)
        ? a.model
        : b.model;

  const ap = resolveScriptPolicies(a);
  const bp = resolveScriptPolicies(b);
  const scriptPolicies = {
    instruction: a.lessons.length >= b.lessons.length ? ap.instruction : bp.instruction,
    demos: (a.demosRequested ?? a.demos.length) >= (b.demosRequested ?? b.demos.length)
      ? ap.demos
      : bp.demos,
    input: ap.input !== bp.input ? ap.input : bp.input,
  };

  const demosRequested = Math.max(
    a.demosRequested ?? a.demos.length,
    b.demosRequested ?? b.demos.length,
    demos.length,
  );

  // Frame policy: prefer fewer frames / cheaper tokens when both set; else keep A's
  const af = a.framePolicy ? resolveFramePolicy(a) : undefined;
  const bf = b.framePolicy ? resolveFramePolicy(b) : undefined;
  let framePolicy = af ?? bf;
  if (af && bf) {
    const aCost = af.n_frames * af.tokens_per_frame;
    const bCost = bf.n_frames * bf.tokens_per_frame;
    framePolicy = aCost <= bCost ? af : bf;
  }
  const framesRequested =
    framePolicy?.n_frames ??
    (a.framesRequested != null || b.framesRequested != null
      ? Math.max(a.framesRequested ?? 0, b.framesRequested ?? 0)
      : undefined);

  const lesson = `Merged ${a.id} + ${b.id}: instruction from ${
    instruction === a.instruction ? a.id : b.id
  }, model ${model.modelId}.`;

  return {
    id: newCandidateId('merge'),
    instruction,
    demos,
    model: { ...model },
    scriptPolicy: scriptPolicies.instruction,
    scriptPolicies,
    framePolicy,
    maxPromptTokens: a.maxPromptTokens ?? b.maxPromptTokens ?? null,
    demosRequested,
    framesRequested: framesRequested || undefined,
    parentIds: [a.id, b.id],
    lessons: [...new Set([...a.lessons, ...b.lessons, lesson])].slice(-12),
  };
}

/** Pick two distinct frontier candidates that maximize coverage diversity. */
export function pickMergeParents(
  frontierIds: string[],
  coverage: Record<string, number>,
  pool: Candidate[],
  rand: () => number,
): [Candidate, Candidate] | null {
  const byId = new Map(pool.map((c) => [c.id, c]));
  const ids = frontierIds.filter((id) => byId.has(id));
  if (ids.length < 2) return null;

  // Prefer top-2 by coverage, with light stochasticity
  const ranked = [...ids].sort(
    (x, y) => (coverage[y] ?? 0) - (coverage[x] ?? 0) || rand() - 0.5,
  );
  const a = byId.get(ranked[0]!)!;
  const b = byId.get(ranked[1]!)!;
  if (a.id === b.id) return null;
  return [a, b];
}
