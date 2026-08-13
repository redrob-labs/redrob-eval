import type { RunFilter, RunRecord } from './types';

/**
 * Filtering lives here, not in the drivers.
 *
 * Two stores that disagree about what `tags: ['a','b']` means are worse than
 * one slow store: a researcher would get different answers from the same
 * question depending on a config value they set months ago. A driver may
 * narrow in its own language first, but the result has to pass this.
 */

function asArray<T>(value: T | T[] | undefined): T[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

export function matchesFilter(run: RunRecord, filter: RunFilter = {}): boolean {
  const kinds = asArray(filter.kind);
  if (kinds && !kinds.includes(run.kind)) return false;

  const statuses = asArray(filter.status);
  if (statuses && !statuses.includes(run.status)) return false;

  // Every tag listed, not any: narrowing is what a filter is for.
  if (filter.tags?.length && !filter.tags.every((t) => run.tags.includes(t))) return false;

  if (filter.paramsHash && run.provenance.paramsHash !== filter.paramsHash) return false;
  if (filter.model && !run.provenance.models.includes(filter.model)) return false;

  if (filter.createdAfter && run.createdAt < filter.createdAfter) return false;
  if (filter.createdBefore && run.createdAt > filter.createdBefore) return false;

  if (filter.search) {
    const needle = filter.search.toLowerCase();
    const hay = `${run.id} ${run.label ?? ''}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

/** Filter, newest first, then page. Ids are timestamped, so id breaks ties. */
export function applyFilter(runs: RunRecord[], filter: RunFilter = {}): RunRecord[] {
  const matched = runs
    .filter((r) => matchesFilter(r, filter))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const offset = filter.offset ?? 0;
  const end = filter.limit == null ? undefined : offset + filter.limit;
  return matched.slice(offset, end);
}
