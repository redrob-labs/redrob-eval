"use client";

import { useMemo, useRef, type ReactNode } from "react";
import { useT } from "@/components/LocaleProvider";
import { ModelPicker, type CatalogModel } from "@/components/ModelPicker";
import { COMPARE_IMAGE_UI_ENABLED } from "@/lib/compare/features";
import type { MessageKey } from "@/lib/i18n";
import { ToolRoutingTaskCard } from "./ToolRoutingTaskCard";
import {
  AUTO_SCORABLE,
  parsePrompts,
  type CompareSetup,
  type DatasetInfo,
  type Modality,
  type SuiteInfo,
} from "./types";

const SAMPLE_PROMPTS = `Summarize this product brief for a PM.

Brief: Acme Ship consolidates carrier rates, ETA predictions and exception alerts for logistics managers at mid-market retailers.
List three risks of shipping a mobile checkout redesign without a staging environment. One sentence each.
Rewrite this error for non-engineers: "ECONNRESET while flushing batch to payments-ledger (timeout=5s)."`;

const SAMPLE_IMAGE_PROMPTS = `A rain-slick Seoul side street at dusk, neon signs reflected in puddles, 35mm photo.
Studio portrait of a ceramicist holding a half-finished bowl, soft window light.
An isometric illustration of a small greenhouse powered by solar panels.`;

const ALL_MODALITIES: Array<{
  id: Modality;
  labelKey: MessageKey;
  hintKey: MessageKey;
}> = [
  {
    id: "text",
    labelKey: "compare.modality.text",
    hintKey: "compare.modality.textHint",
  },
  {
    id: "image",
    labelKey: "compare.modality.image",
    hintKey: "compare.modality.imageHint",
  },
];

/** Text is the product workflow for now; the image stack remains dormant. */
const MODALITIES = ALL_MODALITIES.filter(
  (modality) => modality.id !== "image" || COMPARE_IMAGE_UI_ENABLED,
);

export function SetupStage(props: {
  setup: CompareSetup;
  onChange: (patch: Partial<CompareSetup>) => void;
  datasets: DatasetInfo[];
  suites: SuiteInfo[];
  knownModels: Record<string, CatalogModel>;
  onKnown: (models: CatalogModel[]) => void;
  onStart: () => void;
  starting: boolean;
  /** The live run. Third pane, so a run never replaces the settings it used. */
  runPane: ReactNode;
}) {
  const {
    setup,
    onChange,
    datasets,
    suites,
    knownModels,
    onKnown,
    onStart,
    starting,
    runPane,
  } = props;
  const t = useT();
  const fileRef = useRef<HTMLInputElement>(null);
  const isImage = setup.modality === "image";
  const isTool = setup.taskSource === "tool";

  const parsed = useMemo(
    () => parsePrompts(setup.customPromptsRaw),
    [setup.customPromptsRaw],
  );

  const dataset = datasets.find((d) => d.id === setup.datasetId);
  const suite = suites.find((s) => s.id === setup.suiteId);
  const promptCount =
    setup.taskSource === "custom" ? parsed.prompts.length : setup.sampleCount;
  const autoScored =
    AUTO_SCORABLE[setup.modality] &&
    (setup.taskSource === "dataset" ||
      (parsed.prompts.length > 0 && parsed.prompts.every((p) => p.gold || p.verifier)));

  // One model is a valid run: speed and (when gold exists) quality still
  // measure something. Preference waits until a second answer shows up.
  const minModels = 1;

  const blockedReason =
    setup.modelIds.length < minModels
      ? t("compare.blocked.pickOne")
      : isTool
        ? setup.toolLanguageIds.length === 0
          ? t("compare.blocked.pickLanguage")
          : null
        : setup.taskSource === "custom" && parsed.error
          ? parsed.error
          : promptCount < 1
            ? t("compare.blocked.addPrompt")
            : setup.taskSource === "dataset" && isImage && !setup.suiteId
              ? t("compare.blocked.pickSuite")
              : null;

  function readFile(file: File | null) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      onChange({
        customPromptsRaw:
          typeof reader.result === "string" ? reader.result : "",
        promptSetLabel: file.name.replace(/\.(jsonl?|txt)$/i, ""),
      });
    };
    reader.readAsText(file);
  }

  return (
    <div className="cmp-workspace">
      <div className="cmp-setup">
        {MODALITIES.length > 1 ? (
          <section className="cmp-card">
            <div className="pane-label">{t("compare.modality.label")}</div>
            <div className="cmp-modality-row">
              {MODALITIES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`cmp-modality${setup.modality === m.id ? " on" : ""}`}
                  onClick={() => onChange({ modality: m.id })}
                >
                  <strong>{t(m.labelKey)}</strong>
                  <span>{t(m.hintKey)}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <div className="cmp-setup-grid">
          <section className="cmp-card cmp-card-task">
            <div className="pane-label">{t("compare.task.label")}</div>

            <div className="cmp-seg">
              <button
                type="button"
                className={setup.taskSource === "dataset" ? "on" : undefined}
                onClick={() => onChange({ taskSource: "dataset" })}
              >
                {t(
                  isImage ? "compare.task.suiteTab" : "compare.task.datasetTab",
                )}
              </button>
              <button
                type="button"
                className={setup.taskSource === "custom" ? "on" : undefined}
                onClick={() => onChange({ taskSource: "custom" })}
              >
                {t("compare.task.customTab")}
              </button>
              {/* Tool routing has its own fixtures and its own scoring, and none
                of it applies to an image generator. */}
              {!isImage ? (
                <button
                  type="button"
                  className={setup.taskSource === "tool" ? "on" : undefined}
                  onClick={() => onChange({ taskSource: "tool" })}
                >
                  {t("compare.task.toolTab")}
                </button>
              ) : null}
            </div>

            {isTool ? (
              <ToolRoutingTaskCard setup={setup} onChange={onChange} />
            ) : setup.taskSource === "dataset" ? (
              <>
                <label className="field">
                  <span>
                    {t(
                      isImage
                        ? "compare.task.suiteLabel"
                        : "compare.task.datasetLabel",
                    )}
                  </span>
                  {isImage ? (
                    <select
                      value={setup.suiteId}
                      onChange={(e) => onChange({ suiteId: e.target.value })}
                    >
                      {suites.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <select
                      value={setup.datasetId}
                      onChange={(e) => onChange({ datasetId: e.target.value })}
                    >
                      {datasets.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  )}
                </label>
                <label className="field">
                  <span>
                    {t(
                      isImage
                        ? "compare.task.promptsLabel"
                        : "compare.task.samplesLabel",
                    )}
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={
                      isImage
                        ? (suite?.promptCount ?? 20)
                        : (dataset?.maxSamples ?? 200)
                    }
                    value={setup.sampleCount}
                    onChange={(e) =>
                      onChange({
                        sampleCount: Math.max(1, Number(e.target.value) || 1),
                      })
                    }
                  />
                </label>
                {isImage ? (
                  suite ? (
                    <p className="field-hint">
                      {t("compare.task.suiteHint", {
                        description: suite.description,
                        count: suite.promptCount,
                      })}
                    </p>
                  ) : null
                ) : dataset ? (
                  <p className="field-hint">
                    {t("compare.task.datasetHint", {
                      metric: dataset.metric,
                      max: dataset.maxSamples,
                    })}
                  </p>
                ) : null}
              </>
            ) : (
              <>
                <label className="field">
                  <span>{t("compare.task.promptSetName")}</span>
                  <input
                    type="text"
                    value={setup.promptSetLabel}
                    placeholder={t("compare.task.promptSetPlaceholder")}
                    onChange={(e) =>
                      onChange({ promptSetLabel: e.target.value })
                    }
                  />
                </label>
                <div className="field">
                  <span>{t("compare.task.promptsFieldLabel")}</span>
                  <div className="cmp-prompt-toolbar">
                    <input
                      ref={fileRef}
                      type="file"
                      accept=".jsonl,.json,.txt,text/plain,application/json"
                      className="sr-only"
                      onChange={(e) => readFile(e.target.files?.[0] ?? null)}
                    />
                    <button
                      type="button"
                      className="app-ghost-btn"
                      onClick={() => fileRef.current?.click()}
                    >
                      {t("compare.task.upload")}
                    </button>
                    <button
                      type="button"
                      className="app-ghost-btn"
                      onClick={() =>
                        onChange({
                          customPromptsRaw: isImage
                            ? SAMPLE_IMAGE_PROMPTS
                            : SAMPLE_PROMPTS,
                        })
                      }
                    >
                      {t("compare.task.useSample")}
                    </button>
                    <span className="field-hint">
                      {parsed.error
                        ? parsed.error
                        : t("compare.task.promptCount", {
                            count: parsed.prompts.length,
                          })}
                    </span>
                  </div>
                  <textarea
                    rows={10}
                    spellCheck={false}
                    value={setup.customPromptsRaw}
                    onChange={(e) =>
                      onChange({ customPromptsRaw: e.target.value })
                    }
                  />
                </div>
                {!autoScored && parsed.prompts.length > 0 ? (
                  <p className="field-hint">
                    {t("compare.task.noReferenceHint")}
                  </p>
                ) : null}
              </>
            )}
          </section>

          <section className="cmp-card cmp-card-models">
            <div className="cmp-models-head">
              <div className="pane-label">{t("compare.models.label")}</div>
              <span className="cmp-models-count">
                {t("compare.models.count", { count: setup.modelIds.length })}
                {setup.modelIds.length < minModels
                  ? ` ${t("compare.models.pickAtLeastOne")}`
                  : ""}
              </span>
            </div>
            {isTool ? (
              <p className="field-hint">{t("compare.tool.models.hint")}</p>
            ) : null}
            {setup.modelIds.length > 0 ? (
              <ul className="cmp-chips">
                {[...new Set(setup.modelIds)].map((id) => (
                  <li key={id}>
                    <button
                      type="button"
                      className="cmp-chip"
                      title={t("compare.models.removeTitle", {
                        label: knownModels[id]?.label ?? id,
                      })}
                      onClick={() =>
                        onChange({
                          modelIds: setup.modelIds.filter((x) => x !== id),
                        })
                      }
                    >
                      <span>{knownModels[id]?.label ?? id}</span>
                      <span aria-hidden>×</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="field-hint">{t("compare.models.emptyHint")}</p>
            )}
            <ModelPicker
              selectedIds={setup.modelIds}
              onChange={(ids) => onChange({ modelIds: [...new Set(ids)] })}
              knownModels={knownModels}
              onKnown={onKnown}
              selectMode={setup.modality === "image" ? "image" : "text"}
              hideHeader
              fillHeight
            />
          </section>
        </div>

        <div className="cmp-actions cmp-actions-bar">
          <button
            type="button"
            className="app-run-btn"
            disabled={Boolean(blockedReason) || starting}
            title={blockedReason ?? undefined}
            onClick={onStart}
          >
            {starting
              ? t("compare.actions.starting")
              : t("compare.actions.runComparison")}
          </button>
          {blockedReason ? (
            <p className="cta-disabled-hint">{blockedReason}</p>
          ) : null}
        </div>
      </div>

      <div className="cmp-run-pane">{runPane}</div>
    </div>
  );
}
