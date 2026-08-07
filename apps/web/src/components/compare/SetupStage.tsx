'use client';

import { useMemo, useRef } from 'react';
import { ModelPicker, type CatalogModel } from '@/components/ModelPicker';
import {
  AUTO_SCORABLE,
  parsePrompts,
  type CompareSetup,
  type DatasetInfo,
  type Modality,
  type SuiteInfo,
} from './types';

const SAMPLE_PROMPTS = `Summarize this product brief for a PM.

Brief: Acme Ship consolidates carrier rates, ETA predictions and exception alerts for logistics managers at mid-market retailers.
List three risks of shipping a mobile checkout redesign without a staging environment. One sentence each.
Rewrite this error for non-engineers: "ECONNRESET while flushing batch to payments-ledger (timeout=5s)."`;

const SAMPLE_IMAGE_PROMPTS = `A rain-slick Seoul side street at dusk, neon signs reflected in puddles, 35mm photo.
Studio portrait of a ceramicist holding a half-finished bowl, soft window light.
An isometric illustration of a small greenhouse powered by solar panels.`;

const MODALITIES: Array<{ id: Modality; label: string; hint: string; enabled: boolean }> = [
  { id: 'text', label: 'Text', hint: 'Chat completions', enabled: true },
  { id: 'image', label: 'Image', hint: 'Prompt-to-image', enabled: true },
];

export function SetupStage(props: {
  setup: CompareSetup;
  onChange: (patch: Partial<CompareSetup>) => void;
  datasets: DatasetInfo[];
  suites: SuiteInfo[];
  knownModels: Record<string, CatalogModel>;
  onKnown: (models: CatalogModel[]) => void;
  onStart: () => void;
  starting: boolean;
}) {
  const { setup, onChange, datasets, suites, knownModels, onKnown, onStart, starting } =
    props;
  const fileRef = useRef<HTMLInputElement>(null);
  const isImage = setup.modality === 'image';

  const parsed = useMemo(
    () => parsePrompts(setup.customPromptsRaw),
    [setup.customPromptsRaw],
  );

  const dataset = datasets.find((d) => d.id === setup.datasetId);
  const suite = suites.find((s) => s.id === setup.suiteId);
  const promptCount =
    setup.taskSource === 'custom' ? parsed.prompts.length : setup.sampleCount;
  const autoScored =
    AUTO_SCORABLE[setup.modality] &&
    (setup.taskSource === 'dataset' ||
      (parsed.prompts.length > 0 && parsed.prompts.every((p) => p.gold)));

  const blockedReason =
    setup.modelIds.length < 2
      ? 'Pick at least two models to compare.'
      : setup.taskSource === 'custom' && parsed.error
        ? parsed.error
        : promptCount < 1
          ? 'Add at least one prompt.'
          : setup.taskSource === 'dataset' && isImage && !setup.suiteId
            ? 'Pick a prompt suite.'
            : null;

  function readFile(file: File | null) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      onChange({
        customPromptsRaw: typeof reader.result === 'string' ? reader.result : '',
        promptSetLabel: file.name.replace(/\.(jsonl?|txt)$/i, ''),
      });
    };
    reader.readAsText(file);
  }

  return (
    <div className="cmp-setup">
      <section className="cmp-card">
        <div className="pane-label">Modality</div>
        <div className="cmp-modality-row">
          {MODALITIES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`cmp-modality${setup.modality === m.id ? ' on' : ''}`}
              disabled={!m.enabled}
              onClick={() => onChange({ modality: m.id })}
            >
              <strong>{m.label}</strong>
              <span>{m.hint}</span>
            </button>
          ))}
          <div className="cmp-modality is-planned" aria-disabled>
            <strong>Audio</strong>
            <span>Planned</span>
          </div>
        </div>
      </section>

      <div className="cmp-setup-grid">
        <section className="cmp-card cmp-card-task">
          <div className="pane-label">Task</div>

          <div className="cmp-seg">
            <button
              type="button"
              className={setup.taskSource === 'dataset' ? 'on' : undefined}
              onClick={() => onChange({ taskSource: 'dataset' })}
            >
              {isImage ? 'Prompt suite' : 'Catalog dataset'}
            </button>
            <button
              type="button"
              className={setup.taskSource === 'custom' ? 'on' : undefined}
              onClick={() => onChange({ taskSource: 'custom' })}
            >
              Custom prompts
            </button>
          </div>

          {setup.taskSource === 'dataset' ? (
            <>
              <label className="field">
                <span>{isImage ? 'Suite' : 'Dataset'}</span>
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
                <span>{isImage ? 'Prompts' : 'Samples'}</span>
                <input
                  type="number"
                  min={1}
                  max={
                    isImage ? (suite?.promptCount ?? 20) : (dataset?.maxSamples ?? 200)
                  }
                  value={setup.sampleCount}
                  onChange={(e) =>
                    onChange({ sampleCount: Math.max(1, Number(e.target.value) || 1) })
                  }
                />
              </label>
              {isImage ? (
                suite ? (
                  <p className="field-hint">
                    {suite.description} · {suite.promptCount} prompts available. Images
                    have no reference to score against, so ranking comes from the
                    preference tournament.
                  </p>
                ) : null
              ) : dataset ? (
                <p className="field-hint">
                  Scored with {dataset.metric} · max {dataset.maxSamples} samples.
                </p>
              ) : null}
            </>
          ) : (
            <>
              <label className="field">
                <span>Prompt set name</span>
                <input
                  type="text"
                  value={setup.promptSetLabel}
                  placeholder="Custom prompts"
                  onChange={(e) => onChange({ promptSetLabel: e.target.value })}
                />
              </label>
              <div className="field">
                <span>Prompts (one per line, or JSONL with an &quot;input&quot; field)</span>
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
                    Upload
                  </button>
                  <button
                    type="button"
                    className="app-ghost-btn"
                    onClick={() =>
                      onChange({
                        customPromptsRaw: isImage ? SAMPLE_IMAGE_PROMPTS : SAMPLE_PROMPTS,
                      })
                    }
                  >
                    Use sample
                  </button>
                  <span className="field-hint">
                    {parsed.error
                      ? parsed.error
                      : `${parsed.prompts.length} prompt${parsed.prompts.length === 1 ? '' : 's'}`}
                  </span>
                </div>
                <textarea
                  rows={10}
                  spellCheck={false}
                  value={setup.customPromptsRaw}
                  onChange={(e) => onChange({ customPromptsRaw: e.target.value })}
                />
              </div>
              {!autoScored && parsed.prompts.length > 0 ? (
                <p className="field-hint">
                  No reference answers, so there is no automatic quality score. Rank these
                  with the preference tournament after the run.
                </p>
              ) : null}
            </>
          )}
        </section>

        <section className="cmp-card cmp-card-models">
          <div className="cmp-models-head">
            <div className="pane-label">Models</div>
            <span className="cmp-models-count">
              {setup.modelIds.length} selected
              {setup.modelIds.length < 2 ? ' · pick ≥2' : ''}
            </span>
          </div>
          {setup.modelIds.length > 0 ? (
            <ul className="cmp-chips">
              {setup.modelIds.map((id) => (
                <li key={id}>
                  <button
                    type="button"
                    className="cmp-chip"
                    title={`Remove ${knownModels[id]?.label ?? id}`}
                    onClick={() =>
                      onChange({ modelIds: setup.modelIds.filter((x) => x !== id) })
                    }
                  >
                    <span>{knownModels[id]?.label ?? id}</span>
                    <span aria-hidden>×</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="field-hint">
              Pick at least two. Self-hosted vLLM endpoints sit alongside frontier APIs.
            </p>
          )}
          <ModelPicker
            selectedIds={setup.modelIds}
            onChange={(ids) => onChange({ modelIds: ids })}
            knownModels={knownModels}
            onKnown={onKnown}
            selectMode={setup.modality === 'image' ? 'image' : 'text'}
            hideHeader
            fillHeight
          />
        </section>
      </div>

      <div className="cmp-actions">
        <button
          type="button"
          className="app-run-btn"
          disabled={Boolean(blockedReason) || starting}
          title={blockedReason ?? undefined}
          onClick={onStart}
        >
          {starting ? 'Starting…' : 'Run comparison'}
        </button>
        {blockedReason ? <p className="cta-disabled-hint">{blockedReason}</p> : null}
      </div>
    </div>
  );
}
