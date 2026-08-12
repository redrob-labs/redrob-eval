"use client";

import { useMemo, useState } from "react";
import { useT } from "@/components/LocaleProvider";
import {
  PromptResultTable,
  type PromptResultRow,
} from "./PromptResultTable";
import type { EvalRunResult, EvalTargetSummary } from "./types";

function fmtMs(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${Math.round(v)} ms`;
}

function fmtTokS(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(1)} tok/s`;
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

/** The results pane for text and image runs. Lives beside Setup, never over it. */
export function RunStage(props: {
  running: boolean;
  progress: { done: number; total: number } | null;
  targets: EvalTargetSummary[];
  result: EvalRunResult | null;
  scored: boolean;
  error: string | null;
  onStop: () => void;
  onStartPreference: () => void;
  preferenceReady: boolean;
}) {
  const {
    running,
    progress,
    targets,
    result,
    scored,
    error,
    onStop,
    onStartPreference,
    preferenceReady,
  } = props;
  const t = useT();
  const [openTarget, setOpenTarget] = useState<string | null>(null);
  const [selected, setSelected] = useState<PromptResultRow | null>(null);

  const ranked = useMemo(() => {
    const rows = result?.targets ?? targets;
    return rows
      .slice()
      .sort((a, b) =>
        scored ? b.quality - a.quality : a.meanLatencyMs - b.meanLatencyMs,
      );
  }, [result, targets, scored]);

  /** Inputs only land in meta when the run finishes; live rows show a hint. */
  const promptById = useMemo(
    () => new Map((result?.meta.prompts ?? []).map((p) => [p.id, p.input])),
    [result],
  );

  const openRow = ranked.find((row) => row.targetId === openTarget) ?? null;
  const promptRows = useMemo<PromptResultRow[]>(
    () =>
      (openRow?.sampleResults ?? []).map((s) => ({
        id: s.sampleId,
        values: { score: fmtPct(s.score), latency: fmtMs(s.latencyMs) },
        prompt: promptById.get(s.sampleId) ?? null,
        response: s.prediction,
        error: s.error,
      })),
    [openRow, promptById],
  );

  function pickTarget(targetId: string) {
    setSelected(null);
    setOpenTarget((current) => (current === targetId ? null : targetId));
  }

  const pct =
    progress && progress.total > 0 ? progress.done / progress.total : 0;
  const idle = !running && !result && ranked.length === 0 && !error;

  return (
    <div className="cmp-run">
      <section className="cmp-card">
        <div className="cmp-run-head">
          <div>
            <div className="pane-label">
              {running
                ? t("compare.run.running")
                : result
                  ? t("compare.run.results")
                  : t("compare.run.run")}
            </div>
            <p className="field-hint">
              {idle
                ? t("compare.run.idleHint")
                : scored
                  ? t("compare.run.scoredHint")
                  : t("compare.run.unscoredHint")}
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

        {progress ? (
          <div className="cmp-progress">
            <div className="cmp-progress-bar">
              <div
                className="cmp-progress-fill"
                style={{ width: `${pct * 100}%` }}
              />
            </div>
            <span>
              {t("compare.run.callsProgress", {
                done: progress.done,
                total: progress.total,
              })}
            </span>
          </div>
        ) : null}

        {error ? <div className="app-banner error">{error}</div> : null}
      </section>

      {ranked.length > 0 ? (
        <section className="cmp-card">
          <div className="pane-label">{t("compare.run.ranking")}</div>
          <div className="table-scroll">
            <table className="data-table text-xs">
              <thead>
                <tr>
                  <th>{t("compare.run.table.rank")}</th>
                  <th>{t("compare.run.table.model")}</th>
                  <th>{t("compare.run.table.quality")}</th>
                  <th>{t("compare.run.table.latency")}</th>
                  <th>{t("compare.run.table.ttft")}</th>
                  <th>{t("compare.run.table.throughput")}</th>
                  <th>{t("compare.run.table.n")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {ranked.map((row, i) => {
                  const open = openTarget === row.targetId;
                  return (
                    <tr
                      key={row.targetId}
                      className={open ? "cmp-row-on" : undefined}
                    >
                      <td>{i + 1}</td>
                      <td>
                        <strong>{row.label}</strong>
                        {row.partial ? (
                          <div className="cmp-caveat">
                            {t("compare.run.runningRow")}
                          </div>
                        ) : null}
                        {row.caveat ? (
                          <div className="cmp-caveat" title={row.caveat}>
                            {row.caveat}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        {scored
                          ? row.partial
                            ? `~${fmtPct(row.quality)}`
                            : fmtPct(row.quality)
                          : t("compare.run.unscored")}
                      </td>
                      <td>{fmtMs(row.meanLatencyMs)}</td>
                      <td>{fmtMs(row.meanTtftMs)}</td>
                      <td>{fmtTokS(row.tokensPerSec)}</td>
                      <td>{row.n}</td>
                      <td>
                        <button
                          type="button"
                          className="app-ghost-btn"
                          aria-pressed={open}
                          onClick={() => pickTarget(row.targetId)}
                        >
                          {open
                            ? t("compare.run.hide")
                            : t("compare.run.answers")}
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
                <strong>{openRow.label}</strong>
              </div>
              <PromptResultTable
                idHeader={t("compare.run.table.sample")}
                columns={[
                  ...(scored
                    ? [{ key: "score", label: t("compare.run.table.quality") }]
                    : []),
                  { key: "latency", label: t("compare.run.table.latency") },
                ]}
                rows={promptRows}
                selectedId={selected?.id ?? null}
                onSelect={setSelected}
              />
            </div>
          ) : null}
        </section>
      ) : null}

      {result ? (
        <section className="cmp-card cmp-next">
          <div>
            <div className="pane-label">{t("compare.run.next")}</div>
            <p className="field-hint">{t("compare.run.nextHint")}</p>
          </div>
          <button
            type="button"
            className="app-run-btn"
            disabled={!preferenceReady}
            title={
              preferenceReady ? undefined : t("compare.run.preferenceNeedsTwo")
            }
            onClick={onStartPreference}
          >
            {t("compare.run.startPreference")}
          </button>
        </section>
      ) : null}
    </div>
  );
}
