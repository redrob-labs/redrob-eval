"use client";

import { useState } from "react";
import { useT } from "@/components/LocaleProvider";
import { type PromptResultRow } from "./PromptResultTable";
import {
  ToolRoutingProgressLog,
  type ToolRoutingLogLine,
} from "./ToolRoutingProgressLog";
import { ToolRoutingResultsTable } from "./ToolRoutingResultsTable";
import type { ToolRoutingModelResult } from "./tool-routing";

/**
 * The results pane for taskSource=tool. Same shape as the text pane: live
 * progress on top, then the model-language table, then the open prompt.
 */
export function ToolRoutingRunStage(props: {
  running: boolean;
  progress: { done: number; total: number };
  log: ToolRoutingLogLine[];
  results: ToolRoutingModelResult[];
  error: string | null;
  onStop: () => void;
  onStartPreference: () => void;
  preferenceReady: boolean;
}) {
  const {
    running,
    progress,
    log,
    results,
    error,
    onStop,
    onStartPreference,
    preferenceReady,
  } = props;
  const t = useT();
  const [selected, setSelected] = useState<PromptResultRow | null>(null);

  const done = results.filter((r) => r.report);
  const failed = results.filter((r) => r.error);

  return (
    <div className="cmp-run">
      <section className="cmp-card">
        <div className="cmp-run-head">
          <div>
            <div className="pane-label">
              {running
                ? t("compare.tool.run.running")
                : done.length
                  ? t("compare.tool.run.results")
                  : t("compare.tool.run.idle")}
            </div>
            <p className="field-hint">
              {running
                ? t("compare.tool.run.runningHint")
                : done.length
                  ? t("compare.tool.run.resultsHint")
                  : t("compare.tool.run.idleHint")}
            </p>
          </div>
          {running ? (
            <div className="cmp-run-actions">
              <button type="button" className="app-ghost-btn" onClick={onStop}>
                {t("compare.run.stop")}
              </button>
            </div>
          ) : null}
        </div>

        {running || progress.total > 0 ? (
          <ToolRoutingProgressLog
            done={progress.done}
            total={progress.total}
            lines={log}
            busy={running}
            unit="calls"
          />
        ) : null}

        {error ? <div className="app-banner error">{error}</div> : null}
        {failed.map((r) => (
          <div key={r.modelId} className="app-banner error">
            <strong>{r.label}</strong> {r.error}
          </div>
        ))}
      </section>

      {done.length > 0 ? (
        <>
          <ToolRoutingResultsTable
            results={done}
            selectedPromptId={selected?.id ?? null}
            onSelectPrompt={setSelected}
          />

          <section className="cmp-card cmp-next">
            <div>
              <div className="pane-label">{t("compare.tool.next.title")}</div>
              <p className="field-hint">{t("compare.tool.next.hint")}</p>
            </div>
            <button
              type="button"
              className="app-run-btn"
              disabled={!preferenceReady}
              title={
                preferenceReady ? undefined : t("compare.tool.pref.needTwo")
              }
              onClick={onStartPreference}
            >
              {t("compare.run.startPreference")}
            </button>
          </section>
        </>
      ) : null}
    </div>
  );
}
