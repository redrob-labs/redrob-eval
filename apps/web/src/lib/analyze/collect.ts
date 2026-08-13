import {
  applyAnnotations,
  failuresFromTextEval,
  failuresFromMultiTurn,
  failuresFromToolRouting,
  readAnnotations,
  type FailureKind,
  type FailureRecord,
  type MultiTurnReport,
  type RunStore,
  type ToolRoutingReport,
  type TextEvalReport,
} from '@redrob/harness';

/**
 * Turn a run's stored artifacts into classified failures, annotations applied.
 *
 * Shared by the failures view and the cohort route so both see the same set:
 * a cohort saved from what the screen showed has to be the set the screen
 * showed, not a re-derivation that might drift.
 */
export type AnnotatedFailure = FailureRecord & {
  annotated?: boolean;
  derivedKind?: FailureKind;
  note?: string;
};

/** Reports are recognised by their schema, not their artifact name. */
function failuresFromArtifact(artifact: unknown): FailureRecord[] {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) return [];
  const schema = (artifact as { schema?: string }).schema;
  if (schema === 'redrob-tool-routing/v2') {
    return failuresFromToolRouting(artifact as unknown as ToolRoutingReport);
  }
  if (schema === 'redrob-multi-turn/v1') {
    return failuresFromMultiTurn(artifact as unknown as MultiTurnReport);
  }
  if (schema === 'redrob-text-eval/v1') {
    return failuresFromTextEval(artifact as unknown as TextEvalReport);
  }
  return [];
}

/** Split combined text-eval artifacts into one report reference per model. */
export async function collectTextEvalReports(
  store: RunStore,
  runId: string,
): Promise<Array<{ model: string; report: TextEvalReport }>> {
  const out: Array<{ model: string; report: TextEvalReport }> = [];
  for (const name of await store.listArtifacts(runId)) {
    const artifact = await store.readArtifact(runId, name);
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) continue;
    const report = artifact as unknown as TextEvalReport;
    if (report.schema !== 'redrob-text-eval/v1') continue;
    for (const target of report.targets) {
      if (target.kind === 'model') out.push({ model: target.targetId, report });
    }
  }
  return out;
}

export async function collectRunFailures(
  store: RunStore,
  runId: string,
): Promise<{ failures: AnnotatedFailure[]; artifactCount: number }> {
  const names = await store.listArtifacts(runId);
  const raw: FailureRecord[] = [];
  for (const name of names) {
    raw.push(...failuresFromArtifact(await store.readArtifact(runId, name)));
  }
  const annotations = await readAnnotations(store, runId);
  return { failures: applyAnnotations(raw, annotations), artifactCount: names.length };
}

/** Merge the tool-routing reports in a run, one per model, for a comparison. */
export async function collectToolRoutingReports(
  store: RunStore,
  runId: string,
): Promise<Array<{ model: string; report: ToolRoutingReport }>> {
  const merged = new Map<string, ToolRoutingReport>();
  for (const name of await store.listArtifacts(runId)) {
    const artifact = await store.readArtifact(runId, name);
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) continue;
    const report = artifact as unknown as ToolRoutingReport;
    if (report.schema !== 'redrob-tool-routing/v2') continue;
    const existing = merged.get(report.modelId);
    if (existing) {
      existing.examples = [...(existing.examples ?? []), ...(report.examples ?? [])];
    } else {
      merged.set(report.modelId, { ...report, examples: [...(report.examples ?? [])] });
    }
  }
  return [...merged.entries()].map(([model, report]) => ({ model, report }));
}
