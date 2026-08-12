'use client';

import { useT } from '@/components/LocaleProvider';
import { num, type FertilityCell } from './tool-routing';

/** Tokens-per-word per candidate and language, with Qwen3-0.6B as the 1.0 baseline. */
export function ToolRoutingFertilityTable({ cells }: { cells: FertilityCell[] }) {
  const t = useT();
  if (cells.length === 0) return null;

  return (
    <div className="table-scroll">
      <table className="data-table text-xs">
        <thead>
          <tr>
            <th>{t('compare.tool.col.model')}</th>
            <th>{t('compare.tool.col.language')}</th>
            <th>{t('compare.tool.col.tokensPerWord')}</th>
            <th>{t('compare.tool.col.relative')}</th>
            <th>{t('compare.tool.col.notes')}</th>
          </tr>
        </thead>
        <tbody>
          {cells.map((c) => (
            <tr key={`${c.modelId}-${c.language}`}>
              <td>
                <strong>{c.modelId}</strong>
              </td>
              <td>{c.language}</td>
              <td>
                {c.measured ? (
                  num(c.fertility)
                ) : (
                  <span className="cmp-unmeasured">
                    {t('compare.tool.tokenizer.unmeasured')}
                  </span>
                )}
              </td>
              <td>
                {c.relativeToBaseline == null ? '—' : `${num(c.relativeToBaseline)}×`}
              </td>
              <td className="sub">{c.error ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
