import type { EvalBatch, Example, ReflectiveRecord } from '../types';

/**
 * Build the reflective dataset from minibatch traces + metric feedback.
 * This is Actionable Side Information (ASI) for the reflector LLM.
 */
export function makeReflectiveDataset(params: {
  examples: Example[];
  batch: EvalBatch;
}): ReflectiveRecord[] {
  const byId = new Map(params.examples.map((e) => [e.id, e]));
  const records: ReflectiveRecord[] = [];

  for (const o of params.batch.outcomes) {
    const ex = byId.get(o.exampleId);
    if (!ex) continue;
    const trace =
      params.batch.traces?.find((t) => t.includes(`example=${o.exampleId}`)) ??
      `score=${o.score}; feedback=${o.feedback}`;
    records.push({
      exampleId: o.exampleId,
      input: ex.input,
      gold: ex.gold,
      prediction: o.prediction ?? '',
      score: o.score,
      feedback: o.feedback,
      trace,
    });
  }

  return records;
}

/** Prefer failed / low-score cases for reflection, keep some successes. */
export function prioritizeForReflection(
  records: ReflectiveRecord[],
  limit = 8,
): ReflectiveRecord[] {
  const failed = records.filter((r) => r.score < 1).sort((a, b) => a.score - b.score);
  const ok = records.filter((r) => r.score >= 1);
  const picked = [...failed.slice(0, Math.max(1, limit - 1))];
  if (ok[0] && picked.length < limit) picked.push(ok[0]);
  return picked.slice(0, limit);
}
