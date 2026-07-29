/**
 * Hugging Face datasets-server client (rows API).
 * https://huggingface.co/docs/dataset-viewer/en/rows
 */

const HF_ROWS_BASE = 'https://datasets-server.huggingface.co/rows';
const HF_PAGE_SIZE = 100; // API max

export interface HfRowsResponse {
  features?: unknown[];
  rows?: Array<{ row_idx: number; row: Record<string, unknown> }>;
  num_rows_total?: number;
  error?: string;
  message?: string;
}

export class HfDatasetError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'HfDatasetError';
  }
}

function authHeaders(): Record<string, string> {
  const token = process.env.HF_TOKEN?.trim() || process.env.HUGGINGFACE_HUB_TOKEN?.trim();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

export async function fetchHfRowsPage(params: {
  dataset: string;
  config: string;
  split: string;
  offset: number;
  length: number;
}): Promise<{ rows: Record<string, unknown>[]; total: number | null }> {
  const length = Math.min(Math.max(params.length, 1), HF_PAGE_SIZE);
  const url = new URL(HF_ROWS_BASE);
  url.searchParams.set('dataset', params.dataset);
  url.searchParams.set('config', params.config);
  url.searchParams.set('split', params.split);
  url.searchParams.set('offset', String(params.offset));
  url.searchParams.set('length', String(length));

  const res = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      ...authHeaders(),
    },
  });

  const body = (await res.json().catch(() => ({}))) as HfRowsResponse;

  if (!res.ok) {
    const msg =
      body.error ||
      body.message ||
      `HF datasets-server error ${res.status} for ${params.dataset}`;
    throw new HfDatasetError(msg, res.status);
  }

  if (body.error) {
    throw new HfDatasetError(body.error, res.status);
  }

  const rows = (body.rows ?? []).map((r) => r.row);
  return {
    rows,
    total: typeof body.num_rows_total === 'number' ? body.num_rows_total : null,
  };
}

/**
 * Fetch up to `limit` rows, paging by 100.
 * Tries `dataset`, then optional `fallbackDataset` on auth/gated failure.
 */
export async function fetchHfRows(params: {
  dataset: string;
  fallbackDataset?: string;
  config: string;
  split: string;
  limit: number;
}): Promise<{ rows: Record<string, unknown>[]; usedDataset: string }> {
  const tryFetch = async (dataset: string) => {
    const rows: Record<string, unknown>[] = [];
    let offset = 0;
    while (rows.length < params.limit) {
      const need = Math.min(HF_PAGE_SIZE, params.limit - rows.length);
      const page = await fetchHfRowsPage({
        dataset,
        config: params.config,
        split: params.split,
        offset,
        length: need,
      });
      if (page.rows.length === 0) break;
      rows.push(...page.rows);
      offset += page.rows.length;
      if (page.rows.length < need) break;
      if (page.total != null && offset >= page.total) break;
    }
    return rows;
  };

  try {
    const rows = await tryFetch(params.dataset);
    return { rows, usedDataset: params.dataset };
  } catch (err) {
    const gated =
      err instanceof HfDatasetError &&
      (err.status === 401 ||
        err.status === 403 ||
        /gated|authentication|private|not accessible/i.test(err.message));
    if (!gated || !params.fallbackDataset) throw err;
    const rows = await tryFetch(params.fallbackDataset);
    return { rows, usedDataset: params.fallbackDataset };
  }
}

export { HF_PAGE_SIZE };
