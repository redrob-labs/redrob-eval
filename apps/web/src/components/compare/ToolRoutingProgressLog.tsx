'use client';

import { useEffect, useRef, useState } from 'react';
import { useT } from '@/components/LocaleProvider';

export type ToolRoutingLogLine = {
  id: string;
  text: string;
};

/**
 * Compare's own progress bar plus the streamed step log, so a long tool-routing
 * run reads like the text run rather than a spinner.
 */
export function ToolRoutingProgressLog(props: {
  done: number;
  total: number;
  lines: ToolRoutingLogLine[];
  busy: boolean;
  /** Calls hit the GPU; cells are tokenizer-only. */
  unit: 'calls' | 'cells';
}) {
  const { done, total, lines, busy, unit } = props;
  const t = useT();
  const [open, setOpen] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pct = total > 0 ? Math.min(1, done / total) : 0;

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ block: 'nearest' });
  }, [lines.length, open]);

  if (!busy && lines.length === 0) return null;

  return (
    <div className="cmp-progress-block">
      <div className="cmp-progress">
        <div
          className="cmp-progress-bar"
          role="progressbar"
          aria-valuenow={Math.round(pct * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="cmp-progress-fill" style={{ width: `${pct * 100}%` }} />
        </div>
        <span>
          {total > 0
            ? t(
                unit === 'calls'
                  ? 'compare.tool.progress.calls'
                  : 'compare.tool.progress.cells',
                { done, total },
              )
            : t('compare.tool.progress.starting')}
        </span>
        {lines.length > 0 ? (
          <button
            type="button"
            className="cmp-log-toggle"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open
              ? t('compare.tool.progress.hideLog')
              : t('compare.tool.progress.showLog')}
          </button>
        ) : null}
      </div>

      {open && lines.length > 0 ? (
        <div className="cmp-log" aria-live="polite">
          {lines.map((l) => (
            <div key={l.id}>{l.text}</div>
          ))}
          <div ref={bottomRef} />
        </div>
      ) : null}
    </div>
  );
}
