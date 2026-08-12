"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { useT } from "@/components/LocaleProvider";
import {
  clearReports,
  downloadMarkdown,
  removeReport,
  reportsServerSnapshot,
  reportsSnapshot,
  reportsToMarkdown,
  subscribeReports,
  type SavedReport,
} from "@/lib/compare/report-store";

/**
 * The growing shelf of finished runs, rendered under Setup. Every completed
 * comparison lands here and stays across reloads, so a week of one-off runs
 * becomes one report you can read side by side and export as markdown.
 */
export function CompareReports() {
  const t = useT();
  const [copied, setCopied] = useState(false);

  const reports = useSyncExternalStore(
    subscribeReports,
    reportsSnapshot,
    reportsServerSnapshot,
  );

  const markdown = useMemo(() => reportsToMarkdown(reports), [reports]);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the download button is the fallback */
    }
  }, [markdown]);

  const onClear = useCallback(() => {
    if (typeof window !== "undefined" && !window.confirm(t("compare.reports.clearConfirm"))) {
      return;
    }
    clearReports();
  }, [t]);

  const onRemove = useCallback((id: string) => {
    removeReport(id);
  }, []);

  // Newest first reads better in a list, even though the store keeps arrival order.
  const ordered = useMemo(() => [...reports].reverse(), [reports]);

  return (
    <section className="cmp-reports">
      <div className="cmp-reports-head">
        <div>
          <h2 className="cmp-reports-title">{t("compare.reports.title")}</h2>
          <p className="cmp-reports-lede">
            {reports.length === 0
              ? t("compare.reports.empty")
              : t("compare.reports.count", { n: String(reports.length) })}
          </p>
        </div>
        <div className="cmp-reports-actions">
          <button
            type="button"
            className="app-ghost-btn"
            onClick={() => void onCopy()}
            disabled={reports.length === 0}
          >
            {copied ? t("compare.reports.copied") : t("compare.reports.copy")}
          </button>
          <button
            type="button"
            className="app-ghost-btn"
            onClick={() => downloadMarkdown(markdown)}
            disabled={reports.length === 0}
          >
            {t("compare.reports.download")}
          </button>
          <button
            type="button"
            className="app-ghost-btn cmp-reports-danger"
            onClick={onClear}
            disabled={reports.length === 0}
          >
            {t("compare.reports.clear")}
          </button>
        </div>
      </div>

      {ordered.length > 0 ? (
        <ul className="cmp-reports-list">
          {ordered.map((r) => (
            <li key={r.id} className="cmp-reports-item">
              <div className="cmp-reports-item-main">
                <span className="cmp-reports-badge">
                  {r.kind === "eval"
                    ? t("compare.reports.kind.eval")
                    : t("compare.reports.kind.tool")}
                </span>
                <span className="cmp-reports-item-label">{describe(r)}</span>
              </div>
              <button
                type="button"
                className="app-ghost-btn cmp-reports-x"
                onClick={() => onRemove(r.id)}
                aria-label={t("compare.reports.remove")}
                title={t("compare.reports.remove")}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function describe(r: SavedReport): string {
  if (r.kind === "eval") {
    const models = r.targets.map((tt) => tt.label).join(", ");
    return `${r.datasetLabel} · ${r.metric} · ${models || `${r.targets.length} models`}`;
  }
  const models = r.models.map((m) => m.label).join(", ");
  return `${r.languages.join(", ") || "all"} · ${models || `${r.models.length} models`}`;
}
