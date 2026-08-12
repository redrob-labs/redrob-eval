"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useT } from "@/components/LocaleProvider";
import { PromptResultTable, type PromptResultRow } from "./PromptResultTable";
import {
  downloadToolRoutingReport,
  ms,
  pct,
  type ConditionSlice,
  type ToolRoutingExampleRecord,
  type ToolRoutingModelResult,
  type ToolRoutingReport,
} from "./tool-routing";

type ResultRow = ConditionSlice & {
  id: string;
  modelId: string;
  modelLabel: string;
  report: ToolRoutingReport;
  prompts: ToolRoutingExampleRecord[];
};

type SortKey =
  | "model"
  | "language"
  | "n"
  | "toolSelect"
  | "argExact"
  | "absence"
  | "parseFail"
  | "envelope"
  | "gpuP50"
  | "gpuP95";

type SortState = { key: SortKey; direction: "asc" | "desc" };

const DEFAULT_SORT: SortState = { key: "model", direction: "asc" };

function rowsFromResults(results: ToolRoutingModelResult[]): ResultRow[] {
  return results.flatMap((result) => {
    if (!result.report) return [];
    const report = result.report;
    return report.slices
      .filter((slice) => slice.condition === "contract")
      .map((slice) => ({
        ...slice,
        id: `${result.modelId}:${slice.language}`,
        modelId: result.modelId,
        modelLabel: result.label,
        report,
        prompts: (report.examples ?? []).filter(
          (example) =>
            example.condition === "contract" &&
            example.language === slice.language,
        ),
      }));
  });
}

function sortValue(row: ResultRow, key: SortKey): string | number | null {
  switch (key) {
    case "model":
      return row.modelLabel;
    case "language":
      return row.language;
    case "n":
      return row.n;
    case "toolSelect":
      return row.toolSelectAccuracy;
    case "argExact":
      return row.argExactMatchAccuracy;
    case "absence":
      return row.absenceAccuracy;
    case "parseFail":
      return row.parseFailureRate;
    case "envelope":
      return row.envelope?.errors ?? 0;
    case "gpuP50":
      return row.latencyGpuMs.p50;
    case "gpuP95":
      return row.latencyGpuMs.p95;
  }
}

function compareRows(a: ResultRow, b: ResultRow, sort: SortState): number {
  const av = sortValue(a, sort.key);
  const bv = sortValue(b, sort.key);
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  const compared =
    typeof av === "string" && typeof bv === "string"
      ? av.localeCompare(bv)
      : Number(av) - Number(bv);
  return sort.direction === "asc" ? compared : -compared;
}

function scoreMark(value: boolean | null): string {
  if (value == null) return "·";
  return value ? "✓" : "×";
}

/**
 * "4 (4)": four parse failures were only the wrapper, and all four still named
 * the right tool. A bare rate cannot say that, and without it a model that
 * routes correctly into the wrong key looks like one that cannot route.
 */
function envelopeCell(row: ResultRow): string {
  const envelope = row.envelope;
  if (!envelope || envelope.errors === 0) return "—";
  return `${envelope.errors} (${envelope.toolWouldMatch})`;
}

/** Tool-routing marks fill the shared prompt table's extra columns. */
function promptRows(
  prompts: ToolRoutingExampleRecord[],
  envelopeMark: string,
): PromptResultRow[] {
  return prompts.map((prompt) => ({
    id: prompt.taskId,
    values: {
      toolset: prompt.toolset,
      toolSelect: scoreMark(prompt.score.toolSelectCorrect),
      argExact: scoreMark(prompt.score.argExactMatch),
      absence: scoreMark(prompt.score.absenceCorrect),
      parseFail: prompt.score.envelopeError
        ? envelopeMark
        : prompt.score.parseFailed
          ? "×"
          : "✓",
      latency: ms(prompt.score.latencyGpuMs),
    },
    prompt: prompt.prompt ?? null,
    response: prompt.raw,
    error: prompt.error,
  }));
}

export function ToolRoutingResultsTable(props: {
  results: ToolRoutingModelResult[];
  selectedPromptId: string | null;
  onSelectPrompt: (row: PromptResultRow | null) => void;
}) {
  const { selectedPromptId, onSelectPrompt } = props;
  const t = useT();
  const [modelId, setModelId] = useState("all");
  const [language, setLanguage] = useState("all");
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [openRowId, setOpenRowId] = useState<string | null>(null);

  const allRows = useMemo(
    () => rowsFromResults(props.results),
    [props.results],
  );
  const models = useMemo(
    () =>
      [
        ...new Map(
          allRows.map((row) => [row.modelId, row.modelLabel]),
        ).entries(),
      ].sort((a, b) => a[1].localeCompare(b[1])),
    [allRows],
  );
  const languages = useMemo(
    () => [...new Set(allRows.map((row) => row.language))].sort(),
    [allRows],
  );
  const rows = useMemo(
    () =>
      allRows
        .filter((row) => modelId === "all" || row.modelId === modelId)
        .filter((row) => language === "all" || row.language === language)
        .sort((a, b) => compareRows(a, b, sort)),
    [allRows, language, modelId, sort],
  );

  const openRow = rows.find((row) => row.id === openRowId) ?? null;

  function pickRow(id: string) {
    onSelectPrompt(null);
    setOpenRowId((current) => (current === id ? null : id));
  }

  function toggleSort(key: SortKey) {
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : {
            key,
            direction: key === "model" || key === "language" ? "asc" : "desc",
          },
    );
  }

  function sortableHeader(key: SortKey, label: ReactNode) {
    const active = sort.key === key;
    return (
      <th
        aria-sort={
          active
            ? sort.direction === "asc"
              ? "ascending"
              : "descending"
            : "none"
        }
      >
        <button
          type="button"
          className={`cmp-sort-button${active ? " on" : ""}`}
          onClick={() => toggleSort(key)}
        >
          <span>{label}</span>
          <span aria-hidden>
            {active ? (sort.direction === "asc" ? "↑" : "↓") : "↕"}
          </span>
        </button>
      </th>
    );
  }

  return (
    <section className="cmp-card">
      <div className="pane-label">{t("compare.tool.results.title")}</div>
      <p className="field-hint">{t("compare.tool.results.hint")}</p>

      <div className="cmp-table-filters">
        <label className="field">
          <span>{t("compare.tool.results.filterModel")}</span>
          <select
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
          >
            <option value="all">{t("compare.tool.results.allModels")}</option>
            {models.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("compare.tool.results.filterLanguage")}</span>
          <select
            value={language}
            onChange={(event) => setLanguage(event.target.value)}
          >
            <option value="all">
              {t("compare.tool.results.allLanguages")}
            </option>
            {languages.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="table-scroll cmp-results-table">
        <table className="data-table text-xs">
          <thead>
            <tr>
              {sortableHeader("model", t("compare.tool.col.model"))}
              {sortableHeader("language", t("compare.tool.col.language"))}
              {sortableHeader("n", "n")}
              {sortableHeader("toolSelect", t("compare.tool.col.toolSelect"))}
              {sortableHeader("argExact", t("compare.tool.col.argExact"))}
              {sortableHeader("absence", t("compare.tool.col.absence"))}
              {sortableHeader("parseFail", t("compare.tool.col.parseFail"))}
              {sortableHeader("envelope", t("compare.tool.col.envelope"))}
              {sortableHeader("gpuP50", t("compare.tool.col.gpuP50"))}
              {sortableHeader("gpuP95", t("compare.tool.col.gpuP95"))}
              <th>{t("compare.tool.results.details")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const open = openRowId === row.id;
              return (
                <tr key={row.id} className={open ? "cmp-row-on" : undefined}>
                  <td>
                    <strong>{row.modelLabel}</strong>
                  </td>
                  <td>{row.language}</td>
                  <td>{row.n}</td>
                  <td>{pct(row.toolSelectAccuracy)}</td>
                  <td>{pct(row.argExactMatchAccuracy)}</td>
                  <td>{pct(row.absenceAccuracy)}</td>
                  <td>{pct(row.parseFailureRate)}</td>
                  <td title={t("compare.tool.col.envelopeHint")}>
                    {envelopeCell(row)}
                  </td>
                  <td>{ms(row.latencyGpuMs.p50)}</td>
                  <td>{ms(row.latencyGpuMs.p95)}</td>
                  <td>
                    <button
                      type="button"
                      className="app-ghost-btn"
                      aria-pressed={open}
                      disabled={row.prompts.length === 0}
                      onClick={() => pickRow(row.id)}
                    >
                      {open
                        ? t("compare.tool.results.hidePrompts")
                        : t("compare.tool.results.showPrompts")}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {openRow ? (
        <div className="cmp-prompt-details">
          <div className="cmp-prompt-details-head">
            <strong>
              {openRow.modelLabel} / {openRow.language}
            </strong>
            <button
              type="button"
              className="app-ghost-btn"
              onClick={() => downloadToolRoutingReport(openRow.report)}
            >
              {t("compare.tool.next.download")}
            </button>
          </div>
          <PromptResultTable
            idHeader={t("compare.tool.col.task")}
            columns={[
              { key: "toolset", label: t("compare.tool.col.toolset") },
              { key: "toolSelect", label: t("compare.tool.col.toolSelect") },
              { key: "argExact", label: t("compare.tool.col.argExact") },
              { key: "absence", label: t("compare.tool.col.absence") },
              { key: "parseFail", label: t("compare.tool.col.parseFail") },
              { key: "latency", label: t("compare.tool.col.gpuP50") },
            ]}
            rows={promptRows(openRow.prompts, t("compare.tool.mark.envelope"))}
            selectedId={selectedPromptId}
            onSelect={onSelectPrompt}
          />
        </div>
      ) : null}
    </section>
  );
}
