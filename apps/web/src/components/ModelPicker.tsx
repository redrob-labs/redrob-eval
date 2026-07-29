'use client';

import { useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

export type CatalogModel = {
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
  source: 'curated' | 'openrouter';
  callable: boolean;
};

type ModelsResponse = {
  total: number;
  models: CatalogModel[];
  openrouterConfigured?: boolean;
  openrouterError?: string | null;
  modalityCounts?: Record<string, number>;
  dataSource?: string;
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
  /** Driven by header Text / Image — filters catalog; no separate modality tabs */
  selectMode?: 'text' | 'image';
}) {
  const {
    selectedIds,
    onChange,
    onKnown,
    fillHeight,
    selectMode = 'text',
  } = props;
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [sort, setSort] = useState<'newest' | 'name' | 'weight'>('newest');
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

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          source: 'openrouter',
          limit: '80',
          offset: '0',
          modality,
          sort,
        });
        if (selectMode === 'text') params.set('evalOnly', '1');
        if (selectMode === 'image') params.set('imageOnly', '1');
        if (debouncedQ) params.set('q', debouncedQ);
        const res = await fetch(`/api/models?${params.toString()}`);
        const json = (await res.json()) as ModelsResponse & { error?: string };
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        if (cancelled) return;
        setPage(json.models ?? []);
        setTotal(json.total ?? 0);
        setOrReady(Boolean(json.openrouterConfigured));
        onKnown(json.models ?? []);
        if (json.openrouterError) setError(json.openrouterError);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load models');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [debouncedQ, modality, sort, selectMode, onKnown]);

  const toggle = (m: CatalogModel) => {
    if (!isSelectable(m)) return;
    onKnown([m]);
    if (selectedIds.includes(m.id)) {
      onChange(selectedIds.filter((id) => id !== m.id));
    } else {
      onChange([...selectedIds, m.id]);
    }
  };

  const refreshCatalog = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        source: 'openrouter',
        limit: '80',
        offset: '0',
        modality,
        sort,
        refresh: '1',
      });
      if (selectMode === 'text') params.set('evalOnly', '1');
      if (selectMode === 'image') params.set('imageOnly', '1');
      if (debouncedQ) params.set('q', debouncedQ);
      const res = await fetch(`/api/models?${params.toString()}`);
      const json = (await res.json()) as ModelsResponse & { error?: string };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setPage(json.models ?? []);
      setTotal(json.total ?? 0);
      setOrReady(Boolean(json.openrouterConfigured));
      onKnown(json.models ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Refresh failed');
    } finally {
      setLoading(false);
    }
  }, [debouncedQ, modality, sort, selectMode, onKnown]);

  return (
    <div className={cn('or-models', fillHeight && 'fill')}>
      <div className="or-models-head">
        <div>
          <h3 className="or-models-title">{catalogLabel}</h3>
          <p className="or-models-sub">
            OpenRouter
            {!orReady ? ' · key missing' : ''}
            {' · '}
            {loading ? 'loading…' : `${total}`}
          </p>
        </div>
        <button type="button" className="app-ghost-btn" onClick={() => void refreshCatalog()}>
          Sync
        </button>
      </div>

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
          <option value="weight">Rel. weight</option>
        </select>
      </div>

      {error ? <p className="eval-error">{error}</p> : null}

      <ul className="or-model-list">
        {page.map((m) => {
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
                    ? 'Provider key missing'
                    : !selectable
                      ? selectMode === 'image'
                        ? 'Not an image generator'
                        : 'Not usable for text eval'
                      : on
                        ? 'Remove from eval'
                        : 'Add to eval'
                }
              >
                <div className="or-model-card-top">
                  <span className="or-author-badge" aria-hidden>
                    {authorInitial(m.author)}
                  </span>
                  <div className="or-model-card-titles">
                    <strong>{m.label}</strong>
                    <span className="or-model-slug">{m.modelId}</span>
                  </div>
                  <div className="or-model-card-right">
                    {m.callable ? (
                      <span className={cn('or-select-mark', on && 'checked')}>
                        {on ? 'Selected' : 'Select'}
                      </span>
                    ) : (
                      <span className="or-browse-mark">No key</span>
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
                  <span>
                    w{m.relativeCostWeight}
                    {m.tier ? ` · ${m.tier}` : ''}
                  </span>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
