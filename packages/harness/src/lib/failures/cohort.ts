import type { Json, RunStore } from '../registry/types';

import type { FailureFilter } from './collect';
import type { FailureKind, FailureRecord } from './types';

/**
 * Cohorts and annotations: the two things a triage session produces.
 *
 * Reading failures is only half of error analysis. The other half is doing
 * something with what you found - re-running the twelve items a change was
 * supposed to fix, and recording that you disagree with how one of them was
 * classified. Both are stored, because a triage session whose conclusions live
 * in a terminal scrollback did not happen.
 *
 * A cohort is a registry run of its own, so it is listable with `yarn runs`,
 * carries provenance like anything else, and can be handed to the queue - a
 * cohort is a cell list, which is exactly what the queue consumes.
 */

export const COHORT_KIND = 'cohort';

/** One item in a cohort: enough to re-run it, and to find it again. */
export interface CohortMember {
  model: string;
  item: string;
  language?: string;
  /** The kind it was classified as when the cohort was saved. */
  kind: FailureKind;
}

export interface Cohort {
  id: string;
  name: string;
  /** The run the failures came from. */
  sourceRunId: string;
  /** The filter that produced it, so the selection is reproducible. */
  filter: FailureFilter;
  members: CohortMember[];
}

export async function saveCohort(
  store: RunStore,
  params: {
    name: string;
    sourceRunId: string;
    filter: FailureFilter;
    failures: FailureRecord[];
  },
): Promise<Cohort> {
  const members: CohortMember[] = params.failures.map((f) => ({
    model: f.model,
    item: f.item,
    kind: f.kind,
    ...(f.language ? { language: f.language } : {}),
  }));
  const run = await store.create({
    kind: COHORT_KIND,
    label: params.name,
    tags: ['cohort'],
    models: [...new Set(members.map((m) => m.model))],
    // Both the filter and the members: the filter says what was asked for, the
    // members say what it selected at the time. Re-deriving the members later
    // from a mutated source run would silently change the cohort.
    params: {
      name: params.name,
      sourceRunId: params.sourceRunId,
      filter: params.filter as unknown as Json,
      members: members as unknown as Json,
    },
    status: 'queued',
  });
  // A cohort is a selection, not work in progress; it is done the moment it exists.
  await store.update(run.id, { status: 'done', summary: { members: members.length } });
  return {
    id: run.id,
    name: params.name,
    sourceRunId: params.sourceRunId,
    filter: params.filter,
    members,
  };
}

export async function readCohort(store: RunStore, id: string): Promise<Cohort | null> {
  const run = await store.get(id);
  if (!run || run.kind !== COHORT_KIND) return null;
  const p = run.params as {
    name?: string;
    sourceRunId?: string;
    filter?: FailureFilter;
    members?: CohortMember[];
  };
  return {
    id: run.id,
    name: p.name ?? run.label ?? run.id,
    sourceRunId: p.sourceRunId ?? '',
    filter: p.filter ?? {},
    members: p.members ?? [],
  };
}

/** One researcher's verdict on one failure, overriding or annotating the derived one. */
export interface Annotation {
  /** The failure's id, as `failuresFrom*` produced it. */
  failureId: string;
  /** A kind the reader believes is right, when they disagree with the classifier. */
  kind?: FailureKind;
  note?: string;
  tags?: string[];
  at: string;
}

/** Annotations live beside the run they are about, keyed by failure id. */
export const ANNOTATIONS_ARTIFACT = 'annotations';

export async function readAnnotations(
  store: RunStore,
  runId: string,
): Promise<Record<string, Annotation>> {
  const raw = await store.readArtifact(runId, ANNOTATIONS_ARTIFACT);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as unknown as Record<string, Annotation>;
}

export async function annotateFailure(
  store: RunStore,
  runId: string,
  annotation: Omit<Annotation, 'at'> & { at?: string },
): Promise<Record<string, Annotation>> {
  const current = await readAnnotations(store, runId);
  const next: Record<string, Annotation> = {
    ...current,
    [annotation.failureId]: {
      ...annotation,
      at: annotation.at ?? new Date().toISOString(),
    },
  };
  await store.putArtifact(runId, ANNOTATIONS_ARTIFACT, next as unknown as Json);
  return next;
}

/**
 * Fold annotations over derived failures.
 *
 * The derived kind is kept as `derivedKind` when a human overrode it, so the
 * disagreement stays visible: a classifier that is regularly corrected in the
 * same direction is telling you to fix the classifier.
 */
export function applyAnnotations(
  failures: FailureRecord[],
  annotations: Record<string, Annotation>,
): Array<FailureRecord & { annotated?: boolean; derivedKind?: FailureKind; note?: string }> {
  return failures.map((f) => {
    const annotation = annotations[f.id];
    if (!annotation) return f;
    const out: FailureRecord & {
      annotated?: boolean;
      derivedKind?: FailureKind;
      note?: string;
    } = { ...f, annotated: true };
    if (annotation.note) out.note = annotation.note;
    if (annotation.kind && annotation.kind !== f.kind) {
      out.derivedKind = f.kind;
      out.kind = annotation.kind;
    }
    return out;
  });
}
