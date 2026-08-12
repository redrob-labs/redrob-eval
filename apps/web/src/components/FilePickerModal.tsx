'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '@/components/LocaleProvider';

type Entry = { name: string; path: string; isDir: boolean };
type Listing = {
  dir: string;
  parent: string | null;
  home: string;
  sshDir: string;
  truncated: boolean;
  entries: Entry[];
  error: string | null;
};

/**
 * Server-side file browser. Picks a real path on the machine running the
 * workbench — file contents are never read by the browser.
 * Search filters the current directory only. Opening a folder clears the query.
 */
export function FilePickerModal({
  open,
  initialDir,
  onPick,
  onClose,
}: {
  open: boolean;
  initialDir?: string | null;
  onPick: (filePath: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);
  const seqRef = useRef(0);
  // Freeze the starting directory for this open session so parent re-renders
  // don't re-trigger loads while the user is browsing.
  const startDirRef = useRef<string | null>(null);

  const load = useCallback(async (nextDir?: string | null) => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const qs = nextDir ? `?dir=${encodeURIComponent(nextDir)}` : '';
      const res = await fetch(`/api/settings/browse${qs}`);
      if (seq !== seqRef.current) return;
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `HTTP ${res.status}`);
        return;
      }
      setListing((await res.json()) as Listing);
    } catch {
      if (seq !== seqRef.current) return;
      setError(t('settings.fields.couldNotList'));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [t]);

  /** Navigate into a directory and clear the search box. */
  const goDir = useCallback(
    (next?: string | null) => {
      setQuery('');
      void load(next ?? null);
    },
    [load],
  );

  useEffect(() => {
    if (!open) {
      startDirRef.current = null;
      return;
    }
    startDirRef.current = initialDir ?? null;
    const frame = requestAnimationFrame(() => {
      setQuery('');
      setListing(null);
      void load(startDirRef.current);
    });
    return () => cancelAnimationFrame(frame);
    // Only re-run when the modal opens/closes — not when initialDir churns.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => searchRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [open]);

  const visible = useMemo(() => {
    if (!listing) return [];
    const q = query.trim().toLowerCase();
    if (!q) return listing.entries;
    return listing.entries.filter((e) => e.name.toLowerCase().includes(q));
  }, [listing, query]);

  if (!open) return null;

  return (
    <div className="picker-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="picker" onClick={(e) => e.stopPropagation()}>
        <div className="picker-head">
          <strong>{t('settings.fields.pickerTitle')}</strong>
          <button type="button" className="app-ghost-btn" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>

        <div className="picker-search">
          <input
            ref={searchRef}
            type="search"
            className="picker-search-input"
            value={query}
            placeholder={t('settings.fields.filterFolder')}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query ? (
            <button type="button" className="app-ghost-btn" onClick={() => setQuery('')}>
              {t('common.clear')}
            </button>
          ) : null}
        </div>

        <div className="picker-crumbs">
          <button
            type="button"
            className="picker-crumb"
            onClick={() => goDir(listing?.home)}
            disabled={!listing || loading}
          >
            {t('settings.fields.home')}
          </button>
          <button
            type="button"
            className="picker-crumb"
            onClick={() => goDir(listing?.sshDir)}
            disabled={!listing || loading}
          >
            {t('settings.fields.sshDir')}
          </button>
          <button
            type="button"
            className="picker-crumb"
            onClick={() => goDir(listing?.parent)}
            disabled={!listing?.parent || loading}
          >
            {t('settings.fields.up')}
          </button>
          <code className="picker-path">{listing?.dir ?? '…'}</code>
        </div>

        {error || listing?.error ? (
          <p className="deploy-error">{error ?? listing?.error}</p>
        ) : null}

        <div className={`picker-list${loading ? ' is-loading' : ''}`}>
          {loading && !listing ? (
            <p className="deploy-empty">{t('common.loading')}</p>
          ) : visible.length === 0 ? (
            <p className="deploy-empty">
              {query.trim() ? t('settings.fields.noMatches') : t('settings.fields.emptyDirectory')}
            </p>
          ) : (
            visible.map((e) => (
              <button
                key={e.path}
                type="button"
                className={`picker-row ${e.isDir ? 'dir' : 'file'}`}
                disabled={loading}
                onClick={() => (e.isDir ? goDir(e.path) : onPick(e.path))}
                title={e.path}
              >
                <span className="picker-row-main">
                  <span className="picker-row-name">
                    {e.isDir ? '📁' : '📄'} {e.name}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
