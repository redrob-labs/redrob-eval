"use client";

import { Fragment, type ReactNode } from "react";
import { useT } from "@/components/LocaleProvider";

export interface PromptResultColumn {
  key: string;
  label: string;
}

export interface PromptResultRow {
  id: string;
  /** First cell. Falls back to the row id. */
  label?: ReactNode;
  /** Cells keyed by column key. Missing keys render an em dash. */
  values?: Record<string, ReactNode>;
  /** Exact input sent to the model. Absent on legacy or streaming rows. */
  prompt?: string | null;
  response?: string;
  error?: string;
}

/**
 * One prompt per row, its prompt and reply expanding in the row underneath.
 *
 * The detail used to render after the whole table, so opening the first of
 * fifty rows put the answer fifty rows away from the question.
 *
 * Shared by every Compare modality so an answer is read the same way whether it
 * came from a dataset, a custom prompt set, or the tool-routing harness.
 */
export function PromptResultTable(props: {
  idHeader: string;
  columns?: PromptResultColumn[];
  rows: PromptResultRow[];
  selectedId: string | null;
  onSelect: (row: PromptResultRow | null) => void;
}) {
  const { idHeader, columns = [], rows, selectedId, onSelect } = props;
  const t = useT();

  if (rows.length === 0) return null;

  const span = columns.length + 2;

  return (
    <div className="table-scroll cmp-prompt-table">
      <table className="data-table text-xs">
        <thead>
          <tr>
            <th>{idHeader}</th>
            {columns.map((col) => (
              <th key={col.key}>{col.label}</th>
            ))}
            <th>{t("compare.prompts.details")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const on = selectedId === row.id;
            return (
              <Fragment key={row.id}>
                <tr className={on ? "cmp-row-on" : undefined}>
                  <td>
                    <strong>{row.label ?? row.id}</strong>
                  </td>
                  {columns.map((col) => (
                    <td key={col.key}>{row.values?.[col.key] ?? "—"}</td>
                  ))}
                  <td>
                    <button
                      type="button"
                      className="app-ghost-btn"
                      aria-pressed={on}
                      onClick={() => onSelect(on ? null : row)}
                    >
                      {on
                        ? t("compare.prompts.hide")
                        : t("compare.prompts.show")}
                    </button>
                  </td>
                </tr>
                {on ? (
                  <tr className="cmp-row-detail">
                    <td colSpan={span}>
                      <PromptDetail row={row} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The detail pane body: the exact input, then the reply. */
export function PromptDetail(props: {
  row: PromptResultRow;
  title?: ReactNode;
}) {
  const { row, title } = props;
  const t = useT();

  return (
    <div className="cmp-prompt-stack">
      <div className="cmp-prompt-detail-title">
        <strong>{row.label ?? row.id}</strong>
        {title ? <span className="cmp-caveat">{title}</span> : null}
      </div>
      <div>
        <h4>{t("compare.prompts.prompt")}</h4>
        <pre>{row.prompt || t("compare.prompts.noPrompt")}</pre>
      </div>
      <div>
        <h4>{t("compare.prompts.response")}</h4>
        <pre>
          {row.error
            ? `Error: ${row.error}`
            : row.response || t("common.empty")}
        </pre>
      </div>
    </div>
  );
}
