'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/components/LocaleProvider';
import type { MessageKey } from '@/lib/i18n';
import { readSseJson } from '@/lib/sse';
import { ToolRoutingFertilityTable } from './ToolRoutingFertilityTable';
import {
  ToolRoutingProgressLog,
  type ToolRoutingLogLine,
} from './ToolRoutingProgressLog';
import type { FertilityCell, ToolRoutingCatalog } from './tool-routing';
import type { CompareSetup, ToolRoutingLanguage } from './types';

const LANGUAGE_KEYS: Record<ToolRoutingLanguage, MessageKey> = {
  en: 'compare.tool.language.en',
  hi: 'compare.tool.language.hi',
  'hi-Latn': 'compare.tool.language.hiLatn',
  ko: 'compare.tool.language.ko',
};

type FertilityStreamEvent =
  | { type: 'start'; total: number }
  | { type: 'progress'; done: number; total: number; message: string }
  | { type: 'cell'; cell: FertilityCell }
  | { type: 'done'; cells: FertilityCell[] }
  | { type: 'error'; message: string };

/**
 * The task pane for taskSource=tool. It only describes what will be run: the
 * models come from the same picker the other task sources use, so there is no
 * second model list, host picker or served name to keep in sync here.
 */
export function ToolRoutingTaskCard(props: {
  setup: CompareSetup;
  onChange: (patch: Partial<CompareSetup>) => void;
}) {
  const { setup, onChange } = props;
  const t = useT();
  const [catalog, setCatalog] = useState<ToolRoutingCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [tokenizerError, setTokenizerError] = useState<string | null>(null);
  const [cells, setCells] = useState<FertilityCell[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [log, setLog] = useState<ToolRoutingLogLine[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  /**
   * Never reset, not even when the log is cleared. Aborting a stream does not
   * stop its loop immediately, so a restart used to hand the same ids to two
   * runs at once and React saw duplicate keys.
   */
  const logSeq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/tool-routing/models');
        const body = (await res.json()) as ToolRoutingCatalog & { error?: string };
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        if (!cancelled) {
          setCatalog(body);
          setCatalogError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setCatalogError(
            error instanceof Error ? error.message : t('compare.tool.error.catalog'),
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

  useEffect(() => () => abortRef.current?.abort(), []);

  /** Only the run that currently owns the abort controller may write. */
  const pushLog = useCallback((owner: AbortController, text: string) => {
    if (abortRef.current !== owner) return;
    logSeq.current += 1;
    setLog((prev) => [...prev.slice(-80), { id: `f-${logSeq.current}`, text }]);
  }, []);

  const measureTokenizerCost = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setBusy(true);
    setTokenizerError(null);
    setCells([]);
    setProgress({ done: 0, total: 0 });
    setLog([]);

    try {
      const res = await fetch('/api/tool-routing/fertility', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ languages: setup.toolLanguageIds }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }

      const streamed: FertilityCell[] = [];
      for await (const event of readSseJson<FertilityStreamEvent>(res.body, ac.signal)) {
        // A restart aborts this stream, but the loop can still drain a buffered
        // event or two; those belong to a measurement nobody is watching.
        if (abortRef.current !== ac) break;
        if (event.type === 'start') {
          setProgress({ done: 0, total: event.total });
          pushLog(ac, t('compare.tool.log.tokenizerStart', { total: event.total }));
        } else if (event.type === 'progress') {
          setProgress({ done: event.done, total: event.total });
          pushLog(ac, `${event.done}/${event.total} ${event.message}`);
        } else if (event.type === 'cell') {
          streamed.push(event.cell);
          setCells([...streamed]);
        } else if (event.type === 'done') {
          setCells(event.cells);
          setProgress({ done: event.cells.length, total: event.cells.length });
          pushLog(ac, t('compare.tool.log.tokenizerDone', { count: event.cells.length }));
        } else if (event.type === 'error') {
          throw new Error(event.message);
        }
      }
    } catch (error) {
      const superseded = abortRef.current !== ac;
      if (!superseded && !(error instanceof Error && error.name === 'AbortError')) {
        setTokenizerError(
          error instanceof Error ? error.message : t('compare.tool.error.tokenizer'),
        );
      }
    } finally {
      // Only the run still holding the controller may say the pane is idle.
      if (abortRef.current === ac) {
        abortRef.current = null;
        setBusy(false);
      }
    }
  }, [pushLog, setup.toolLanguageIds, t]);

  const languages = (catalog?.languages ?? ['en', 'hi', 'hi-Latn', 'ko']) as ToolRoutingLanguage[];
  const selectedTaskCount = setup.toolLanguageIds.reduce(
    (sum, language) => sum + (catalog?.stubTasks.byLanguage[language] ?? 0),
    0,
  );
  const selectedToolsetCount = (toolset: 'core' | 'wide' | 'full') =>
    setup.toolLanguageIds.reduce(
      (sum, language) =>
        sum + (catalog?.stubTasks.byLanguageToolset[language]?.[toolset] ?? 0),
      0,
    );

  function toggleLanguage(language: ToolRoutingLanguage) {
    const selected = setup.toolLanguageIds.includes(language);
    onChange({
      toolLanguageIds: selected
        ? setup.toolLanguageIds.filter((id) => id !== language)
        : [...setup.toolLanguageIds, language],
    });
  }

  return (
    <>
      <p className="field-hint">{t('compare.tool.task.hint')}</p>
      <div className="field">
        <span>{t('compare.tool.languages.label')}</span>
        <div className="cmp-seg" role="group" aria-label={t('compare.tool.languages.label')}>
          {languages.map((language) => (
            <button
              key={language}
              type="button"
              className={setup.toolLanguageIds.includes(language) ? 'on' : undefined}
              aria-pressed={setup.toolLanguageIds.includes(language)}
              onClick={() => toggleLanguage(language)}
            >
              {t(LANGUAGE_KEYS[language])}
            </button>
          ))}
        </div>
        <p className="field-hint">{t('compare.tool.languages.hint')}</p>
      </div>
      {catalog ? (
        <p className="cmp-facts">
          {t('compare.tool.task.selectedCount', { total: selectedTaskCount })}
        </p>
      ) : null}
      {catalog ? (
        <p className="cmp-facts">
          {t('compare.tool.task.toolsetCounts', {
            core: selectedToolsetCount('core'),
            coreTools: catalog.toolsets.core,
            wide: selectedToolsetCount('wide'),
            wideTools: catalog.toolsets.wide,
            full: selectedToolsetCount('full'),
            fullTools: catalog.toolsets.full,
          })}
        </p>
      ) : null}
      {catalogError ? <div className="app-banner error">{catalogError}</div> : null}
      <p className="field-hint">{t('compare.tool.task.countsNote')}</p>

      <p className="field-hint">{t('compare.tool.conditions.contractOnly')}</p>

      <details className="cmp-details">
        <summary>{t('compare.tool.tokenizer.label')}</summary>
        <p className="field-hint">{t('compare.tool.tokenizer.hint')}</p>
        <div className="cmp-actions">
          <button
            type="button"
            className="app-ghost-btn"
            disabled={busy}
            onClick={() => void measureTokenizerCost()}
          >
            {busy ? t('compare.tool.tokenizer.running') : t('compare.tool.tokenizer.run')}
          </button>
        </div>

        {busy || log.length > 0 ? (
          <ToolRoutingProgressLog
            done={progress.done}
            total={progress.total}
            lines={log}
            busy={busy}
            unit="cells"
          />
        ) : null}

        {tokenizerError ? <div className="app-banner error">{tokenizerError}</div> : null}

        {cells.length > 0 ? (
          <ToolRoutingFertilityTable cells={cells} />
        ) : !busy ? (
          <p className="field-hint">{t('compare.tool.tokenizer.empty')}</p>
        ) : null}
      </details>
    </>
  );
}
