import { hashParams } from '../registry/provenance';
import type { Json } from '../registry/types';

import type { Cell } from './types';

/**
 * Turn named dimensions into cells: the cartesian product, one cell per combo.
 *
 * The combo is the cell's params, and its key is a hash of that combo so the
 * same square gets the same key on every run - which is the whole basis of
 * resume. Insertion order of the dimensions is preserved so the grid reads the
 * way it was written.
 */
export function expandMatrix(params: {
  dimensions: Record<string, Json[]>;
  /** Which dimension names a cell's concurrency group, e.g. 'provider'. */
  groupBy?: string;
  /** Override the derived key. Rarely needed; the hash is stable already. */
  key?: (combo: Record<string, Json>) => string;
}): Cell[] {
  const names = Object.keys(params.dimensions);
  for (const name of names) {
    if (params.dimensions[name]!.length === 0) {
      // A dimension with no values would make the product empty and silently
      // drop the whole grid. That is never what was meant.
      throw new Error(`matrix dimension "${name}" has no values`);
    }
  }

  let combos: Array<Record<string, Json>> = [{}];
  for (const name of names) {
    const next: Array<Record<string, Json>> = [];
    for (const combo of combos) {
      for (const value of params.dimensions[name]!) {
        next.push({ ...combo, [name]: value });
      }
    }
    combos = next;
  }

  const seen = new Set<string>();
  return combos.map((combo) => {
    const key = params.key ? params.key(combo) : hashParams(combo);
    if (seen.has(key)) {
      // Only reachable through a custom key function that is not injective.
      throw new Error(`matrix produced a duplicate cell key: ${key}`);
    }
    seen.add(key);
    const cell: Cell = { key, params: combo };
    if (params.groupBy) {
      const group = combo[params.groupBy];
      if (group !== undefined) cell.group = String(group);
    }
    return cell;
  });
}
