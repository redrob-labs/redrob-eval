'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from '@/components/LocaleProvider';
import type { MessageKey } from '@/lib/i18n';
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
    precision: string;
    license: string;
    hfRepoId: string;
    maxModelLen: number;
    /** Read back from the endpoint, so the row names the weights actually served. */
    live?: {
      reachable: boolean;
      synced: boolean;
      baseUrl: string;
      error: string | null;
    };
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

const SOURCE_LABEL_KEYS: Record<ModelSource, MessageKey> = {
  selfhosted: 'models.source.selfhosted',
  frontier: 'models.source.frontier',
  openrouter: 'models.source.openrouter',
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
  const t = useT();
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
  const catalogLabel = t(selectMode === 'image' ? 'models.imageLabel' : 'models.textLabel');

  const isSelectable = (m: CatalogModel) => {
    if (!m.callable) return false;
    if (selectMode === 'image') {
      return Boolean(m.imageGenEligible || m.modalities?.includes('image'));
    }
    return Boolean(m.evalEligible);
  };

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q.trim()), 220);
    return () => clearTimeout(timer);
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
          setError(e instanceof Error ? e.message : t('models.failedToLoad'));
        }
      } finally {
        if (!isCancelled?.()) setLoading(false);
      }
    },
    [buildParams, onKnown, t],
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
      onChange([...new Set([...selectedIds, m.id])]);
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
          placeholder={t('common.searchModels')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="or-search"
        />
      </div>
      <select
        value={sort}
        onChange={(e) => setSort(e.target.value as typeof sort)}
        className="or-sort"
        aria-label={t('models.sortAria')}
      >
        <option value="newest">{t('models.sortNewest')}</option>
        <option value="name">{t('models.sortName')}</option>
      </select>
      {hideHeader ? (
        <>
          <span className="or-models-embed-status">
            {loading ? t('common.loading') : `${total}`}
            {!orReady ? ` ${t('models.noKeySuffix')}` : ''}
          </span>
          <button
            type="button"
            className="app-ghost-btn"
            onClick={() => void load(true)}
          >
            {t('models.sync')}
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
              {t('models.sourceSummary')}
              {!orReady ? ` ${t('models.noOpenrouterKey')}` : ''}
              {' · '}
              {loading ? t('models.loading') : `${total}`}
            </p>
          </div>
          <button
            type="button"
            className="app-ghost-btn"
            onClick={() => void load(true)}
          >
            {t('models.sync')}
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
          {t('models.source.all')}
        </button>
        {SOURCE_ORDER.map((s) => (
          <button
            key={s}
            type="button"
            className={cn('or-source-chip', sourceFilter === s && 'on')}
            onClick={() => setSourceFilter(s)}
          >
            {t(SOURCE_LABEL_KEYS[s])} ({counts[s]})
          </button>
        ))}
      </div>

      {error ? <p className="eval-error">{error}</p> : null}

      <div className="or-model-groups">
        {groups.map((group) => (
          <section key={group.source} className="or-model-group">
            <h4 className="or-model-group-title">
              {t(SOURCE_LABEL_KEYS[group.source])}
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
                          ? m.selfHosted?.live && !m.selfHosted.live.reachable
                            ? t('models.title.vllmUnreachable', {
                                baseUrl: m.selfHosted.live.baseUrl,
                              })
                            : t('models.title.vllmNotConfigured')
                          : t('models.title.providerKeyMissing')
                        : !selectable
                          ? selectMode === 'image'
                            ? t('models.title.notImageGenerator')
                            : t('models.title.notTextEval')
                          : on
                            ? t('models.title.removeFromComparison')
                            : t('models.title.addToComparison')
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
                            {on ? t('models.selected') : t('models.select')}
                          </span>
                        ) : (
                          <span className="or-browse-mark">
                            {m.source === 'selfhosted'
                              ? m.selfHosted?.live && !m.selfHosted.live.reachable
                                ? t('models.endpointDown')
                                : t('models.notDeployed')
                              : t('models.noKey')}
                          </span>
                        )}
                      </div>
                    </div>
                    {m.description ? <p className="or-model-desc">{m.description}</p> : null}
                    <div className="or-model-meta-row">
                      <span>{t('common.by', { name: m.author || m.providerId })}</span>
                      {formatDate(m.created) ? <span>{formatDate(m.created)}</span> : null}
                      {m.contextLength ? (
                        <span>{t('models.contextK', { k: Math.round(m.contextLength / 1000) })}</span>
                      ) : null}
                      {m.selfHosted ? (
                        <span>
                          {t('models.hfPrecision', {
                            hf: m.selfHosted.hfRepoId,
                            precision: m.selfHosted.precision,
                          })}
                        </span>
                      ) : null}
                      {m.selfHosted?.live?.synced ? (
                        <span className="or-live-mark">{t('models.servingNow')}</span>
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
        <p className="or-models-sub">{t('models.noMatch')}</p>
      ) : null}
    </div>
  );
}
