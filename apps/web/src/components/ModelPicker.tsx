'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';

export type ModelSource = 'selfhosted' | 'frontier' | 'openrouter';

export type CatalogModel = {
  /** Canonical `<providerId>/<modelId>` */
  id: string;
  label: string;
  providerId: string;
  modelId: string;
  relativeCostWeight: number;
  tier: string | null;
  contextLength?: number | null;
  created?: number | null;
  author?: string | null;
  modalities?: string[];
  evalEligible?: boolean;
  imageGenEligible?: boolean;
  description?: string | null;
  source: ModelSource;
  callable: boolean;
  selfHosted?: {
    axis: 'S' | 'L';
    precision: string;
    license: string;
    hfRepoId: string;
    maxModelLen: number;
  } | null;
};

type ModelsResponse = {
  total: number;
  models: CatalogModel[];
  openrouterConfigured?: boolean;
  openrouterError?: string | null;
  modalityCounts?: Record<string, number>;
  dataSource?: string;
};

const SOURCE_ORDER: ModelSource[] = ['selfhosted', 'frontier', 'openrouter'];

const SOURCE_LABELS: Record<ModelSource, string> = {
  selfhosted: 'Self-hosted (vLLM)',
  frontier: 'Frontier APIs',
  openrouter: 'OpenRouter',
};

function formatDate(created?: number | null): string {
  if (!created) return '';
  try {
    return new Date(created * 1000).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return '';
  }
}

function authorInitial(author?: string | null): string {
  return (author || '?').slice(0, 1).toUpperCase();
}

export function ModelPicker(props: {
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  knownModels: Record<string, CatalogModel>;
  onKnown: (models: CatalogModel[]) => void;
  fillHeight?: boolean;
  /** Filters the catalog to models that can serve this modality */
  selectMode?: 'text' | 'image';
  /** Hide catalog title; put Sync beside search */
  hideHeader?: boolean;
}) {
  const {
    selectedIds,
    onChange,
    onKnown,
    fillHeight,
    selectMode = 'text',
    hideHeader = false,
  } = props;
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [sort, setSort] = useState<'newest' | 'name'>('newest');
  const [sourceFilter, setSourceFilter] = useState<ModelSource | 'all'>('all');
  const [page, setPage] = useState<CatalogModel[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orReady, setOrReady] = useState(false);

  const modality = selectMode === 'image' ? 'image' : 'text';
  const catalogLabel =
    selectMode === 'image' ? 'Image generators' : 'Text chat models';

  const isSelectable = (m: CatalogModel) => {
    if (!m.callable) return false;
    if (selectMode === 'image') {
      return Boolean(m.imageGenEligible || m.modalities?.includes('image'));
    }
    return Boolean(m.evalEligible);
  };

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 220);
    return () => clearTimeout(t);
  }, [q]);

  const buildParams = useCallback(
    (refresh: boolean) => {
      const params = new URLSearchParams({
        source: 'all',
        limit: '120',
        offset: '0',
        modality,
        sort,
      });
      if (refresh) params.set('refresh', '1');
      if (selectMode === 'text') params.set('evalOnly', '1');
      if (selectMode === 'image') params.set('imageOnly', '1');
      if (debouncedQ) params.set('q', debouncedQ);
      return params;
    },
    [debouncedQ, modality, sort, selectMode],
  );

  const load = useCallback(
    async (refresh: boolean, isCancelled?: () => boolean) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/models?${buildParams(refresh).toString()}`);
        const json = (await res.json()) as ModelsResponse & { error?: string };
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        if (isCancelled?.()) return;
        setPage(json.models ?? []);
        setTotal(json.total ?? 0);
        setOrReady(Boolean(json.openrouterConfigured));
        onKnown(json.models ?? []);
        if (json.openrouterError) setError(json.openrouterError);
      } catch (e) {
        if (!isCancelled?.()) {
          setError(e instanceof Error ? e.message : 'Failed to load models');
        }
      } finally {
        if (!isCancelled?.()) setLoading(false);
      }
    },
    [buildParams, onKnown],
  );

  useEffect(() => {
    let cancelled = false;
    // Deferred so the fetch's first setState lands after this render commits.
    const frame = requestAnimationFrame(() => {
      void load(false, () => cancelled);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [load]);

  const toggle = (m: CatalogModel) => {
    if (!isSelectable(m)) return;
    onKnown([m]);
    if (selectedIds.includes(m.id)) {
      onChange(selectedIds.filter((id) => id !== m.id));
    } else {
      onChange([...selectedIds, m.id]);
    }
  };

  const groups = useMemo(() => {
    const visible =
      sourceFilter === 'all' ? page : page.filter((m) => m.source === sourceFilter);
    return SOURCE_ORDER.map((source) => ({
      source,
      models: visible.filter((m) => m.source === source),
    })).filter((g) => g.models.length > 0);
  }, [page, sourceFilter]);

  const counts = useMemo(() => {
    const out: Record<ModelSource, number> = {
      selfhosted: 0,
      frontier: 0,
      openrouter: 0,
    };
    for (const m of page) out[m.source] += 1;
    return out;
  }, [page]);

  const tools = (
    <div className="or-models-tools">
      <div className="or-search-wrap">
        <input
          type="search"
          placeholder="Search models…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="or-search"
        />
      </div>
      <select
        value={sort}
        onChange={(e) => setSort(e.target.value as typeof sort)}
        className="or-sort"
        aria-label="Sort"
      >
        <option value="newest">Newest</option>
        <option value="name">Name</option>
      </select>
      {hideHeader ? (
        <>
          <span className="or-models-embed-status">
            {loading ? 'Loading…' : `${total}`}
            {!orReady ? ' · no key' : ''}
          </span>
          <button
            type="button"
            className="app-ghost-btn"
            onClick={() => void load(true)}
          >
            Sync
          </button>
        </>
      ) : null}
    </div>
  );

  return (
    <div className={cn('or-models', fillHeight && 'fill')}>
      {!hideHeader ? (
        <div className="or-models-head">
          <div>
            <h3 className="or-models-title">{catalogLabel}</h3>
            <p className="or-models-sub">
              Self-hosted · frontier · OpenRouter
              {!orReady ? ' · OpenRouter key missing' : ''}
              {' · '}
              {loading ? 'loading…' : `${total}`}
            </p>
          </div>
          <button
            type="button"
            className="app-ghost-btn"
            onClick={() => void load(true)}
          >
            Sync
          </button>
        </div>
      ) : null}

      {tools}

      <div className="or-source-filters">
        <button
          type="button"
          className={cn('or-source-chip', sourceFilter === 'all' && 'on')}
          onClick={() => setSourceFilter('all')}
        >
          All
        </button>
        {SOURCE_ORDER.map((s) => (
          <button
            key={s}
            type="button"
            className={cn('or-source-chip', sourceFilter === s && 'on')}
            onClick={() => setSourceFilter(s)}
          >
            {SOURCE_LABELS[s]} ({counts[s]})
          </button>
        ))}
      </div>

      {error ? <p className="eval-error">{error}</p> : null}

      <div className="or-model-groups">
        {groups.map((group) => (
          <section key={group.source} className="or-model-group">
            <h4 className="or-model-group-title">
              {SOURCE_LABELS[group.source]}
              <span className="or-model-group-count">{group.models.length}</span>
            </h4>
            <ul className="or-model-list">
            {group.models.map((m) => {
              const on = selectedIds.includes(m.id);
              const selectable = isSelectable(m);
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    className={cn(
                      'or-model-card',
                      on && 'on',
                      !selectable && 'browse-only',
                      !m.callable && 'no-key',
                    )}
                    disabled={!m.callable}
                    onClick={() => {
                      if (selectable) toggle(m);
                    }}
                    title={
                      !m.callable
                        ? m.source === 'selfhosted'
                          ? 'vLLM endpoint not configured — set it up on Deploy'
                          : 'Provider key missing'
                        : !selectable
                          ? selectMode === 'image'
                            ? 'Not an image generator'
                            : 'Not usable for text eval'
                          : on
                            ? 'Remove from comparison'
                            : 'Add to comparison'
                    }
                  >
                    <div className="or-model-card-top">
                      <span className="or-author-badge" aria-hidden>
                        {authorInitial(m.author)}
                      </span>
                      <div className="or-model-card-titles">
                        <strong>{m.label}</strong>
                        <span className="or-model-slug">{m.id}</span>
                      </div>
                      <div className="or-model-card-right">
                        {m.callable ? (
                          <span className={cn('or-select-mark', on && 'checked')}>
                            {on ? 'Selected' : 'Select'}
                          </span>
                        ) : (
                          <span className="or-browse-mark">
                            {m.source === 'selfhosted' ? 'Not deployed' : 'No key'}
                          </span>
                        )}
                      </div>
                    </div>
                    {m.description ? <p className="or-model-desc">{m.description}</p> : null}
                    <div className="or-model-meta-row">
                      <span>by {m.author || m.providerId}</span>
                      {formatDate(m.created) ? <span>{formatDate(m.created)}</span> : null}
                      {m.contextLength ? (
                        <span>{Math.round(m.contextLength / 1000)}K context</span>
                      ) : null}
                      {m.selfHosted ? (
                        <span>
                          axis {m.selfHosted.axis} · {m.selfHosted.precision}
                        </span>
                      ) : null}
                      {m.tier ? <span>{m.tier}</span> : null}
                    </div>
                  </button>
                </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>

      {!loading && groups.length === 0 ? (
        <p className="or-models-sub">No models match this filter.</p>
      ) : null}
    </div>
  );
}
