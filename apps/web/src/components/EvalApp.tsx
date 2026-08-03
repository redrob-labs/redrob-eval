'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { GettingStartedPanel } from '@/components/GettingStartedPanel';
import { ImagePreferencePanel } from '@/components/ImagePreferencePanel';
import { ModelPicker, type CatalogModel } from '@/components/ModelPicker';
import { ParetoChart } from '@/components/ParetoChart';
import { EvolutionParetoChart } from '@/components/EvolutionParetoChart';
import {
  EvolutionProgressChart,
  appendRolloutStep,
  type EvolveRolloutStep,
} from '@/components/EvolutionProgressChart';
import type {
  Candidate,
  EvalRunResult,
  EvalStreamEvent,
  EvalTargetSummary,
  FrontierPoint,
  OptimizeEvent,
  OptimizeReport,
} from '@redrob/harness';
import type { ImageRunMeta, ImageRunStreamEvent } from '@/lib/image-eval/types';
import type { CorpusStats, RoutingRunMeta, RoutingRunSummary } from '@redrob/harness';
import { fmtMs, pct } from '@/lib/utils';
import type { AppMode, ModuleId } from '@/lib/modules';

type StatusResponse = {
  port: number;
  providers: { id: string; label: string; configured: boolean }[];
  models: {
    id: string;
    label: string;
    providerId: string;
    modelId: string;
    relativeCostWeight: number;
    tier: string | null;
    callable: boolean;
  }[];
};

type DatasetInfo = {
  id: string;
  label: string;
  task: string;
  metric: string;
  maxSamples: number;
  notes: string | null;
};

type ImageSuiteInfo = {
  id: string;
  label: string;
  description: string;
  promptCount: number;
  scoring: string;
  notes: string[] | null;
};

type RunProgressRow = {
  id: string;
  label: string;
  done: number;
  total: number;
  status: 'pending' | 'running' | 'done' | 'error' | 'stopped';
  detail?: string;
  errors: number;
};

const SAMPLE_PRESETS = [5, 20, 50, 100, 200] as const;
const PROMPT_PRESETS = [2, 3, 6] as const;
const GUIDE_KEY = 'redrob.guideDismissed';

type DragPane = 'config' | 'models';

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException
    ? e.name === 'AbortError'
    : e instanceof Error && e.name === 'AbortError';
}

function moduleIdForMode(mode: AppMode): ModuleId {
  return mode;
}

export function EvalApp({ mode }: { mode: AppMode }) {
  const router = useRouter();
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
  const [imageSuites, setImageSuites] = useState<ImageSuiteInfo[]>([]);
  const [pastRuns, setPastRuns] = useState<ImageRunMeta[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [datasetId, setDatasetId] = useState('gsm8k-main');
  const [sampleCount, setSampleCount] = useState(20);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [selectedImageModels, setSelectedImageModels] = useState<string[]>([]);
  const [knownModels, setKnownModels] = useState<Record<string, CatalogModel>>({});
  const [routerSmallId, setRouterSmallId] = useState('');
  const [routerLargeId, setRouterLargeId] = useState('');
  const [smallOkThreshold, setSmallOkThreshold] = useState(0.99);
  const [corpus, setCorpus] = useState<CorpusStats | null>(null);
  const [routingRuns, setRoutingRuns] = useState<
    Array<{ meta: RoutingRunMeta; summary: RoutingRunSummary | null }>
  >([]);

  const [qualityFloor, setQualityFloor] = useState(0.55);
  const [maxRollouts, setMaxRollouts] = useState(12);
  const [minibatchSize, setMinibatchSize] = useState(4);
  const [evolveInstruction, setEvolveInstruction] = useState('');
  const [evolveSource, setEvolveSource] = useState<'catalog' | 'custom'>('catalog');
  const [customGoalText, setCustomGoalText] = useState('');
  const [customRubric, setCustomRubric] = useState('');
  const [customExamplesRaw, setCustomExamplesRaw] = useState(
    [
      '{"id":"1","input":"Candidate: …\\nJob: …"}',
      '{"id":"2","input":"Candidate: …\\nJob: …"}',
      '{"id":"3","input":"Candidate: …\\nJob: …"}',
    ].join('\n'),
  );
  const [evolveJudgeModelId, setEvolveJudgeModelId] = useState('');
  const [frontierPoints, setFrontierPoints] = useState<FrontierPoint[]>([]);
  const [evolveHistory, setEvolveHistory] = useState<EvolveRolloutStep[]>([]);
  const [evolveView, setEvolveView] = useState<'progress' | 'frontier'>('progress');
  const [bestCandidate, setBestCandidate] = useState<Candidate | null>(null);
  const [evolveLesson, setEvolveLesson] = useState<string | null>(null);
  const [evolveTestQuality, setEvolveTestQuality] = useState<number | null>(null);
  const [evolveReport, setEvolveReport] = useState<OptimizeReport | null>(null);
  const [maxPromptTokens, setMaxPromptTokens] = useState(2048);
  const OPT_RUN_KEY = 'redrob.activeOptimizeRunId';
  const activeOptRunRef = useRef<string | null>(null);

  const [suiteId, setSuiteId] = useState('sfw-image');
  const [promptLimit, setPromptLimit] = useState(3);
  const [seed, setSeed] = useState(42);
  const [autoJudge, setAutoJudge] = useState(true);
  const [judgeModelId, setJudgeModelId] = useState('or/openai/gpt-4o');
  const [activeImageRunId, setActiveImageRunId] = useState<string | null>(null);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [runProgress, setRunProgress] = useState<RunProgressRow[]>([]);
  const [liveTargets, setLiveTargets] = useState<EvalTargetSummary[]>([]);
  const [result, setResult] = useState<EvalRunResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [statusLine, setStatusLine] = useState('Idle');
  const [configWidth, setConfigWidth] = useState(300);
  const [modelsWidth, setModelsWidth] = useState(420);
  const [showGuide, setShowGuide] = useState(true);
  const [sampleLoading, setSampleLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const canRun = Boolean(status?.providers.some((p) => p.configured));
  const openrouterReady = Boolean(
    status?.providers.find((p) => p.id === 'openrouter')?.configured,
  );

  const mergeKnown = useCallback((models: CatalogModel[]) => {
    setKnownModels((prev) => {
      const next = { ...prev };
      for (const m of models) next[m.id] = m;
      return next;
    });
  }, []);

  const routerOptions = useMemo(() => {
    const fromSelected = selectedModels
      .map((id) => knownModels[id])
      .filter(Boolean) as CatalogModel[];
    const curated = (status?.models ?? []).map(
      (m): CatalogModel => ({
        ...m,
        source: 'curated',
        evalEligible: true,
      }),
    );
    const map = new Map<string, CatalogModel>();
    for (const m of [...curated, ...fromSelected, ...Object.values(knownModels)]) {
      map.set(m.id, m);
    }
    return Array.from(map.values()).filter((m) => m.callable && m.evalEligible !== false);
  }, [selectedModels, knownModels, status]);

  const smallOptions = routerOptions.filter((m) => m.tier === 'small' || m.tier == null);
  const largeOptions = routerOptions.filter((m) => m.tier === 'large');

  const refreshPastRuns = useCallback(async () => {
    try {
      const res = await fetch('/api/image/runs');
      const json = (await res.json()) as { runs?: ImageRunMeta[] };
      setPastRuns(json.runs ?? []);
    } catch {
      // ignore
    }
  }, []);

  const refreshRoutingData = useCallback(async () => {
    try {
      const res = await fetch('/api/routing/runs');
      const json = (await res.json()) as {
        runs?: Array<{ meta: RoutingRunMeta; summary: RoutingRunSummary | null }>;
        corpus?: CorpusStats;
      };
      setRoutingRuns(json.runs ?? []);
      setCorpus(json.corpus ?? null);
    } catch {
      // ignore
    }
  }, []);

  const bootstrap = useCallback(async () => {
    setLoadError(null);
    try {
      const [sRes, dRes, mRes, iRes] = await Promise.all([
        fetch('/api/status'),
        fetch('/api/datasets'),
        fetch('/api/models?source=curated&limit=50'),
        fetch('/api/image/suites'),
      ]);
      const sJson = (await sRes.json()) as StatusResponse;
      const dJson = (await dRes.json()) as { datasets: DatasetInfo[] };
      const mJson = (await mRes.json()) as { models: CatalogModel[] };
      const iJson = (await iRes.json()) as { suites: ImageSuiteInfo[] };
      setStatus(sJson);
      setDatasets(dJson.datasets ?? []);
      setImageSuites(iJson.suites ?? []);
      mergeKnown(mJson.models ?? []);

      const callables = (mJson.models ?? []).filter((m) => m.callable);
      setSelectedModels((prev) =>
        prev.length ? prev : callables.slice(0, 2).map((m) => m.id),
      );

      const small =
        callables.find((m) => m.tier === 'small') ??
        callables.slice().sort((a, b) => a.relativeCostWeight - b.relativeCostWeight)[0];
      const large =
        callables.find((m) => m.tier === 'large') ??
        callables.slice().sort((a, b) => b.relativeCostWeight - a.relativeCostWeight)[0];
      if (small) setRouterSmallId((prev) => prev || small.id);
      if (large) setRouterLargeId((prev) => prev || large.id);
      if (dJson.datasets?.[0] && !dJson.datasets.find((d) => d.id === 'gsm8k-main')) {
        setDatasetId(dJson.datasets[0].id);
      }
      if (iJson.suites?.[0]) {
        setSuiteId((prev) => prev || iJson.suites[0].id);
      }
      await refreshPastRuns();
      await refreshRoutingData();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load status');
    }
  }, [mergeKnown, refreshPastRuns, refreshRoutingData]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(GUIDE_KEY) === '1') setShowGuide(false);
    } catch {
      // ignore
    }
  }, []);

  const dismissGuide = useCallback(() => {
    setShowGuide(false);
    try {
      window.localStorage.setItem(GUIDE_KEY, '1');
    } catch {
      // ignore
    }
  }, []);

  const openGuide = useCallback(() => {
    setShowGuide(true);
    try {
      window.localStorage.removeItem(GUIDE_KEY);
    } catch {
      // ignore
    }
  }, []);

  const applyStarterSettings = useCallback(() => {
    setRunError(null);
    if (mode === 'evolve') {
      setEvolveSource('catalog');
      setDatasetId(
        datasets.some((d) => d.id === 'gsm8k-main') ? 'gsm8k-main' : (datasets[0]?.id ?? 'gsm8k-main'),
      );
      setSampleCount(5);
      setMaxRollouts(6);
      setMinibatchSize(2);
      setQualityFloor(0.55);
      setMaxPromptTokens(2048);
      setEvolveInstruction('');
      if (!routerSmallId && routerOptions[0]) setRouterSmallId(routerOptions[0].id);
      setStatusLine('Starter applied — click Run GEPA');
      return;
    }
    if (mode === 'image') {
      setSuiteId(
        imageSuites.some((s) => s.id === 'sfw-image')
          ? 'sfw-image'
          : (imageSuites[0]?.id ?? 'sfw-image'),
      );
      setPromptLimit(2);
      setSeed(42);
      setAutoJudge(true);
      setStatusLine(
        selectedImageModels.length
          ? 'Starter applied — click Run image'
          : 'Starter applied — pick ≥1 image model, then Run',
      );
      return;
    }
    setDatasetId(
      datasets.some((d) => d.id === 'gsm8k-main') ? 'gsm8k-main' : (datasets[0]?.id ?? 'gsm8k-main'),
    );
    setSampleCount(5);
    setSmallOkThreshold(0.99);
    const small =
      smallOptions[0] ??
      routerOptions.slice().sort((a, b) => a.relativeCostWeight - b.relativeCostWeight)[0];
    const large =
      largeOptions[0] ??
      routerOptions.slice().sort((a, b) => b.relativeCostWeight - a.relativeCostWeight)[0];
    if (small) setRouterSmallId(small.id);
    if (large && large.id !== small?.id) setRouterLargeId(large.id);
    else if (routerOptions.length > 1) {
      const other = routerOptions.find((m) => m.id !== small?.id);
      if (other) setRouterLargeId(other.id);
    }
    setStatusLine('Starter applied — click Collect routing data');
  }, [
    mode,
    datasets,
    imageSuites,
    routerSmallId,
    routerOptions,
    smallOptions,
    largeOptions,
    selectedImageModels.length,
  ]);

  const loadSampleReport = useCallback(async () => {
    setSampleLoading(true);
    setRunError(null);
    try {
      const res = await fetch('/api/samples/optimize-report');
      const json = (await res.json()) as OptimizeReport & { error?: string };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      if (mode !== 'evolve') {
        router.push('/evolve');
        return;
      }
      setEvolveView('progress');
      setEvolveReport(json);
      setFrontierPoints(json.frontier ?? []);
      // Offline sample has no rollout stream — synthesize seed → evolved timeline.
      const sampleSteps: EvolveRolloutStep[] = [];
      const baseVal = json.baseline?.val;
      const evoVal = json.evolved?.val;
      if (json.baseline?.candidate && baseVal) {
        sampleSteps.push({
          index: 0,
          candidateId: json.baseline.candidate.id,
          quality: baseVal.quality,
          totalTokens: baseVal.totalTokens,
          meanRelativeCost: baseVal.meanRelativeCost,
          feasible: baseVal.quality >= json.qualityFloor,
          bestQualitySoFar: null,
          bestTokensSoFar: null,
        });
      }
      if (json.evolved?.candidate && evoVal) {
        sampleSteps.push({
          index: sampleSteps.length,
          candidateId: json.evolved.candidate.id,
          quality: evoVal.quality,
          totalTokens: evoVal.totalTokens,
          meanRelativeCost: evoVal.meanRelativeCost,
          feasible: evoVal.quality >= json.qualityFloor,
          bestQualitySoFar: null,
          bestTokensSoFar: null,
        });
      }
      let rebuilt: EvolveRolloutStep[] = [];
      for (const s of sampleSteps) {
        rebuilt = appendRolloutStep(rebuilt, {
          index: s.index,
          candidateId: s.candidateId,
          quality: s.quality,
          totalTokens: s.totalTokens,
          meanRelativeCost: s.meanRelativeCost,
          feasible: s.feasible,
        });
      }
      setEvolveHistory(rebuilt);
      setBestCandidate(json.evolved?.candidate ?? null);
      setEvolveLesson(null);
      setEvolveTestQuality(json.evolved?.test?.quality ?? null);
      setQualityFloor(json.qualityFloor);
      if (json.datasetId) setDatasetId(json.datasetId);
      setResult(null);
      setLiveTargets([]);
      setRunProgress([]);
      setStatusLine('Sample report (offline) — no API calls');
    } catch (e) {
      setRunError(e instanceof Error ? e.message : 'Failed to load sample report');
    } finally {
      setSampleLoading(false);
    }
  }, [mode, router]);

  const startResize = useCallback(
    (pane: DragPane, event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      window.getSelection()?.removeAllRanges();

      const startX = event.clientX;
      const startConfig = configWidth;
      const startModels = modelsWidth;
      const prevUserSelect = document.body.style.userSelect;
      const prevCursor = document.body.style.cursor;

      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
      document.body.classList.add('is-pane-resizing');

      const onMove = (moveEvent: PointerEvent) => {
        moveEvent.preventDefault();
        const dx = moveEvent.clientX - startX;
        if (pane === 'config') {
          setConfigWidth(Math.max(240, Math.min(460, startConfig + dx)));
        } else {
          setModelsWidth(Math.max(280, Math.min(720, startModels + dx)));
        }
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        document.body.style.userSelect = prevUserSelect;
        document.body.style.cursor = prevCursor;
        document.body.classList.remove('is-pane-resizing');
      };

      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onUp);
    },
    [configWidth, modelsWidth],
  );

  const activeTextRunRef = useRef<string | null>(null);
  const TEXT_RUN_KEY = 'redrob.activeTextRunId';

  const consumeTextEvents = useCallback(
    async (runId: string, signal: AbortSignal) => {
      const res = await fetch(`/api/routing/runs/${encodeURIComponent(runId)}/events`, {
        method: 'GET',
        signal,
        headers: { Accept: 'text/event-stream' },
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() ?? '';
        for (const chunk of chunks) {
          const dataLine = chunk
            .split('\n')
            .map((l) => l.trim())
            .find((l) => l.startsWith('data:'));
          if (!dataLine) continue;
          const event = JSON.parse(dataLine.slice(5).trim()) as EvalStreamEvent;
          if (event.type === 'start') {
            setProgress({ done: 0, total: event.totalCalls });
            setStatusLine(`Collect ${event.runId}`);
            setRunProgress(
              event.targets
                .filter((t) => t.kind === 'model')
                .map((t) => ({
                  id: t.targetId,
                  label: t.label,
                  done: 0,
                  total: event.sampleCount,
                  status: 'pending' as const,
                  errors: 0,
                })),
            );
          } else if (event.type === 'progress') {
            setProgress({ done: event.done, total: event.total });
            setStatusLine(
              event.error
                ? `fail · ${event.targetId}`
                : `${event.targetId} · ${event.sampleId}`,
            );
            setRunProgress((prev) =>
              prev.map((row) => {
                if (row.id !== event.targetId) return row;
                const nextDone = Math.min(row.total, row.done + 1);
                return {
                  ...row,
                  done: nextDone,
                  status: nextDone >= row.total ? 'done' : 'running',
                  detail: event.error
                    ? event.error
                    : `${event.sampleId}${event.score != null ? ` · ${pct(event.score)}` : ''}`,
                  errors: row.errors + (event.error ? 1 : 0),
                };
              }),
            );
          } else if (event.type === 'target_done') {
            setLiveTargets((prev) => {
              const rest = prev.filter((t) => t.targetId !== event.target.targetId);
              return [...rest, event.target];
            });
          } else if (event.type === 'done') {
            setResult(event.result);
            setLiveTargets(event.result.targets);
            setProgress({
              done: event.result.meta.sampleCount * 2,
              total: event.result.meta.sampleCount * 2,
            });
            setStatusLine(`Saved · ${event.result.meta.runId}`);
            setRunProgress((prev) =>
              prev.map((row) => ({ ...row, done: row.total, status: 'done' })),
            );
            sessionStorage.removeItem(TEXT_RUN_KEY);
            activeTextRunRef.current = null;
            await refreshRoutingData();
          } else if (event.type === 'cancelled') {
            setStatusLine('Stopped');
            setRunProgress((prev) =>
              prev.map((row) =>
                row.status === 'running' || row.status === 'pending'
                  ? { ...row, status: 'stopped', detail: 'Stopped' }
                  : row,
              ),
            );
            sessionStorage.removeItem(TEXT_RUN_KEY);
            activeTextRunRef.current = null;
            await refreshRoutingData();
          } else if (event.type === 'error') {
            setRunError(event.message);
            setStatusLine('Failed');
            sessionStorage.removeItem(TEXT_RUN_KEY);
            activeTextRunRef.current = null;
          }
        }
      }
    },
    [refreshRoutingData],
  );

  // Reconnect to an in-flight text collection after browser refresh
  useEffect(() => {
    const runId = sessionStorage.getItem('redrob.activeTextRunId');
    if (!runId) return;
    let cancelled = false;
    const ac = new AbortController();
    abortRef.current = ac;
    activeTextRunRef.current = runId;
    setRunning(true);
    setStatusLine(`Reconnecting · ${runId}`);
    void (async () => {
      try {
        await consumeTextEvents(runId, ac.signal);
      } catch (e) {
        if (!cancelled && !isAbortError(e)) {
          setRunError(e instanceof Error ? e.message : 'Reconnect failed');
          setStatusLine('Failed');
          sessionStorage.removeItem('redrob.activeTextRunId');
        }
      } finally {
        if (!cancelled) {
          abortRef.current = null;
          setRunning(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [consumeTextEvents]);

  const stopRun = useCallback(() => {
    const textRunId = activeTextRunRef.current;
    if (textRunId) {
      void fetch(`/api/routing/runs/${encodeURIComponent(textRunId)}/events`, {
        method: 'DELETE',
      });
    }
    const optRunId = activeOptRunRef.current;
    if (optRunId) {
      void fetch(`/api/optimize/runs/${encodeURIComponent(optRunId)}/events`, {
        method: 'DELETE',
      });
    }
    abortRef.current?.abort();
    setStatusLine('Stopping…');
  }, []);

  const runTextEval = async () => {
    if (running) return;
    if (!routerSmallId || !routerLargeId) {
      setRunError('Pick small and large models for dual-eval collection');
      return;
    }
    const ac = new AbortController();
    abortRef.current = ac;
    setRunning(true);
    setRunError(null);
    setResult(null);
    setLiveTargets([]);
    setProgress({ done: 0, total: 0 });
    setRunProgress([]);
    setStatusLine('Collecting routing data…');

    try {
      const startRes = await fetch('/api/routing/collect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ac.signal,
        body: JSON.stringify({
          datasetId,
          sampleCount,
          smallModelId: routerSmallId,
          largeModelId: routerLargeId,
          smallOkThreshold,
        }),
      });
      const startBody = (await startRes.json().catch(() => ({}))) as {
        runId?: string;
        error?: string;
      };
      if (!startRes.ok || !startBody.runId) {
        throw new Error(startBody.error || `HTTP ${startRes.status}`);
      }

      const runId = startBody.runId;
      activeTextRunRef.current = runId;
      sessionStorage.setItem(TEXT_RUN_KEY, runId);
      setStatusLine(`Collect ${runId}`);
      await consumeTextEvents(runId, ac.signal);
    } catch (e) {
      if (isAbortError(e)) {
        setStatusLine('Stopped');
        setRunProgress((prev) =>
          prev.map((row) =>
            row.status === 'running' || row.status === 'pending'
              ? { ...row, status: 'stopped', detail: 'Stopped' }
              : row,
          ),
        );
        await refreshRoutingData();
      } else {
        setRunError(e instanceof Error ? e.message : 'Collection failed');
        setStatusLine('Failed');
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  };

  const consumeOptimizeEvents = useCallback(async (runId: string, signal: AbortSignal) => {
    const res = await fetch(`/api/optimize/runs/${encodeURIComponent(runId)}/events`, {
      method: 'GET',
      signal,
      headers: { Accept: 'text/event-stream' },
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() ?? '';
      for (const chunk of chunks) {
        const dataLine = chunk
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        const event = JSON.parse(dataLine.slice(5).trim()) as OptimizeEvent;
        if (event.type === 'start') {
          setProgress({ done: 0, total: event.maxRollouts });
          setEvolveHistory([]);
          setEvolveView('progress');
          setStatusLine(`GEPA ${event.runId ?? runId}`);
        } else if (event.type === 'rollout') {
          setProgress((p) => ({
            done: Math.min(p.total || event.index + 1, event.index + 1),
            total: p.total || maxRollouts,
          }));
          setEvolveHistory((prev) =>
            appendRolloutStep(prev, {
              index: event.index,
              candidateId: event.candidate.id,
              quality: event.val.quality,
              totalTokens: event.val.totalTokens,
              meanRelativeCost: event.val.meanRelativeCost,
              feasible: event.feasible,
            }),
          );
          setStatusLine(
            `${event.feasible ? 'ok' : 'infeasible'} · ${event.candidate.id} · q=${pct(event.val.quality)}`,
          );
        } else if (event.type === 'frontier') {
          setFrontierPoints(event.points);
        } else if (event.type === 'reflect') {
          setEvolveLesson(event.lesson);
          setStatusLine(`reflect · ${event.childId}`);
        } else if (event.type === 'merge') {
          setStatusLine(`merge · ${event.childId}`);
        } else if (event.type === 'done') {
          setBestCandidate(event.best);
          setFrontierPoints(event.frontier);
          setEvolveTestQuality(event.test?.quality ?? null);
          setProgress({ done: event.rollouts, total: event.rollouts });
          setStatusLine(`Done · ${event.best?.id ?? 'no feasible'}`);
          sessionStorage.removeItem(OPT_RUN_KEY);
          activeOptRunRef.current = null;
          void fetch(`/api/optimize/runs/${encodeURIComponent(runId)}`)
            .then((r) => r.json())
            .then((body: { report?: OptimizeReport | null }) => {
              if (body.report) setEvolveReport(body.report);
            })
            .catch(() => undefined);
        } else if (event.type === 'cancelled') {
          setStatusLine('Stopped');
          sessionStorage.removeItem(OPT_RUN_KEY);
          activeOptRunRef.current = null;
        } else if (event.type === 'error') {
          setRunError(event.message);
          setStatusLine('Failed');
          sessionStorage.removeItem(OPT_RUN_KEY);
          activeOptRunRef.current = null;
        }
      }
    }
  }, [maxRollouts]);

  // Reconnect GEPA optimize job after refresh
  useEffect(() => {
    const runId = sessionStorage.getItem('redrob.activeOptimizeRunId');
    if (!runId) return;
    let cancelled = false;
    const ac = new AbortController();
    abortRef.current = ac;
    activeOptRunRef.current = runId;
    if (mode !== 'evolve') {
      router.push('/evolve');
      return;
    }
    setRunning(true);
    setStatusLine(`Reconnecting GEPA · ${runId}`);
    void (async () => {
      try {
        await consumeOptimizeEvents(runId, ac.signal);
      } catch (e) {
        if (!cancelled && !isAbortError(e)) {
          setRunError(e instanceof Error ? e.message : 'Reconnect failed');
          setStatusLine('Failed');
          sessionStorage.removeItem('redrob.activeOptimizeRunId');
        }
      } finally {
        if (!cancelled) {
          abortRef.current = null;
          setRunning(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [consumeOptimizeEvents, mode, router]);

  const runEvolve = async () => {
    if (running) return;
    if (!routerSmallId) {
      setRunError('Pick a seed model');
      return;
    }
    if (evolveSource === 'custom') {
      if (!customGoalText.trim() || !customRubric.trim()) {
        setRunError('Custom goal requires both goal and rubric');
        return;
      }
      if (!customExamplesRaw.trim()) {
        setRunError('Paste at least 3 JSONL examples with an "input" field');
        return;
      }
    }
    const ac = new AbortController();
    abortRef.current = ac;
    setRunning(true);
    setRunError(null);
    setFrontierPoints([]);
    setEvolveHistory([]);
    setEvolveView('progress');
    setBestCandidate(null);
    setEvolveLesson(null);
    setEvolveTestQuality(null);
    setEvolveReport(null);
    setProgress({ done: 0, total: maxRollouts });
    setStatusLine('Starting GEPA…');

    try {
      const base = {
        seedModelId: routerSmallId,
        reflectModelId: routerLargeId || routerSmallId,
        modelCatalogIds: selectedModels.length
          ? selectedModels
          : [routerSmallId, routerLargeId].filter(Boolean),
        qualityFloor,
        maxRollouts,
        minibatchSize,
        mergeEvery: 3,
        seed,
        maxPromptTokens,
        instruction: evolveInstruction || undefined,
        optimizer: 'gepa' as const,
        optimizedAgainst: ['train', 'val'] as Array<'train' | 'val'>,
      };
      const body =
        evolveSource === 'custom'
          ? {
              ...base,
              customGoal: {
                goal: customGoalText,
                rubric: customRubric,
                examplesRaw: customExamplesRaw,
              },
              judgeModelId:
                evolveJudgeModelId || routerLargeId || routerSmallId,
            }
          : {
              ...base,
              datasetId,
              sampleCount,
            };

      const startRes = await fetch('/api/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ac.signal,
        body: JSON.stringify(body),
      });
      const startBody = (await startRes.json().catch(() => ({}))) as {
        runId?: string;
        error?: string;
      };
      if (!startRes.ok || !startBody.runId) {
        throw new Error(startBody.error || `HTTP ${startRes.status}`);
      }
      activeOptRunRef.current = startBody.runId;
      sessionStorage.setItem(OPT_RUN_KEY, startBody.runId);
      await consumeOptimizeEvents(startBody.runId, ac.signal);
    } catch (e) {
      if (isAbortError(e)) {
        setStatusLine('Stopped');
      } else {
        setRunError(e instanceof Error ? e.message : 'Optimize failed');
        setStatusLine('Failed');
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  };

  const runImageEval = async () => {
    if (running) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setRunning(true);
    setRunError(null);
    setProgress({ done: 0, total: 0 });
    setRunProgress([]);
    setStatusLine('Starting image run…');
    setActiveImageRunId(null);

    try {
      const res = await fetch('/api/image/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ac.signal,
        body: JSON.stringify({
          suiteId,
          modelIds: selectedImageModels,
          seed,
          promptLimit,
          autoJudge,
          judgeModelId,
        }),
      });

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() ?? '';
        for (const chunk of chunks) {
          const line = chunk.trim();
          if (!line.startsWith('data:')) continue;
          const event = JSON.parse(line.slice(5).trim()) as ImageRunStreamEvent;
          if (event.type === 'start') {
            setActiveImageRunId(event.runId);
            setProgress({ done: 0, total: event.total });
            setStatusLine(`Run ${event.runId}`);
            setRunProgress(
              event.models.map((m) => ({
                id: m.id,
                label: m.label,
                done: 0,
                total: event.promptCount,
                status: 'pending',
                errors: 0,
              })),
            );
          } else if (event.type === 'progress') {
            setProgress({ done: event.done, total: event.total });
            setStatusLine(
              event.ok
                ? `${event.promptId} · ${event.modelId}`
                : `fail · ${event.message ?? event.promptId}`,
            );
            setRunProgress((prev) =>
              prev.map((row) => {
                if (row.id !== event.modelId) return row;
                const nextDone = Math.min(row.total, row.done + 1);
                return {
                  ...row,
                  done: nextDone,
                  status: nextDone >= row.total ? 'done' : 'running',
                  detail: event.ok
                    ? event.promptId
                    : event.message || `fail · ${event.promptId}`,
                  errors: row.errors + (event.ok ? 0 : 1),
                };
              }),
            );
          } else if (event.type === 'judging') {
            setStatusLine(`Auto-judge · ${event.promptId}`);
            setRunProgress((prev) =>
              prev.map((row) =>
                row.status === 'done'
                  ? { ...row, detail: `judging · ${event.promptId}` }
                  : row,
              ),
            );
          } else if (event.type === 'done') {
            setActiveImageRunId(event.runId);
            setStatusLine(`Done · ${event.runId}`);
            setRunProgress((prev) =>
              prev.map((row) => ({ ...row, done: row.total, status: 'done' })),
            );
            await refreshPastRuns();
          } else if (event.type === 'cancelled') {
            setStatusLine('Stopped');
            if (event.runId) setActiveImageRunId(event.runId);
            setRunProgress((prev) =>
              prev.map((row) =>
                row.status === 'running' || row.status === 'pending'
                  ? { ...row, status: 'stopped', detail: 'Stopped' }
                  : row,
              ),
            );
            await refreshPastRuns();
          } else if (event.type === 'error') {
            setRunError(event.message);
            setStatusLine('Failed');
            if (event.runId) setActiveImageRunId(event.runId);
          }
        }
      }
    } catch (e) {
      if (isAbortError(e)) {
        setStatusLine('Stopped');
        setRunProgress((prev) =>
          prev.map((row) =>
            row.status === 'running' || row.status === 'pending'
              ? { ...row, status: 'stopped', detail: 'Stopped' }
              : row,
          ),
        );
        await refreshPastRuns();
      } else {
        setRunError(e instanceof Error ? e.message : 'Image eval failed');
        setStatusLine('Failed');
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  };

  const displayTargets = result?.targets ?? liveTargets;
  const progressPct = progress.total > 0 ? (progress.done / progress.total) * 100 : 0;
  const selectedDataset = datasets.find((d) => d.id === datasetId);
  const selectedSuite = imageSuites.find((s) => s.id === suiteId);
  const configuredCount = status?.providers.filter((p) => p.configured).length ?? 0;

  const runDisabled =
    running ||
    !canRun ||
    (mode === 'text'
      ? !routerSmallId || !routerLargeId || routerSmallId === routerLargeId
      : mode === 'evolve'
        ? !routerSmallId
        : !openrouterReady || selectedImageModels.length < 1);

  const runBlockedReason = (() => {
    if (running || !runDisabled) return null;
    if (!canRun) {
      return 'Add a provider key to repo-root .env, restart yarn dev, then Refresh.';
    }
    if (mode === 'text') {
      if (!routerSmallId || !routerLargeId) return 'Pick both Small and Large models in Config.';
      if (routerSmallId === routerLargeId) return 'Small and Large must be different models.';
    }
    if (mode === 'evolve' && !routerSmallId) return 'Pick a Seed model in Config.';
    if (mode === 'image') {
      if (!openrouterReady) return 'Image mode needs OPENROUTER_API_KEY in repo-root .env.';
      if (selectedImageModels.length < 1) return 'Select at least one image generator in the catalog.';
    }
    return null;
  })();

  return (
    <AppShell
      module={moduleIdForMode(mode)}
      port={status?.port ?? 3939}
      center={
        <>
          <div className="app-progress-track">
            <div className="app-progress-bar" style={{ width: `${progressPct}%` }} />
          </div>
          <span className="app-status-text">
            {statusLine}
            {progress.total > 0 ? ` · ${progress.done}/${progress.total}` : ''}
          </span>
        </>
      }
      right={
        <>
          <span className="app-muted" title="Configured provider keys / total providers">
            keys {configuredCount}/{status?.providers.length ?? 0}
          </span>
          <button
            type="button"
            className="app-ghost-btn"
            onClick={() => (showGuide ? dismissGuide() : openGuide())}
          >
            {showGuide ? 'Hide guide' : 'Guide'}
          </button>
          <button type="button" className="app-ghost-btn" onClick={() => void bootstrap()}>
            Refresh
          </button>
          {running ? (
            <button type="button" className="app-stop-btn" onClick={stopRun}>
              Stop
            </button>
          ) : (
            <button
              type="button"
              className="app-run-btn"
              disabled={runDisabled}
              title={runBlockedReason ?? undefined}
              onClick={() =>
                void (mode === 'text'
                  ? runTextEval()
                  : mode === 'evolve'
                    ? runEvolve()
                    : runImageEval())
              }
            >
              {mode === 'text'
                ? 'Collect routing data'
                : mode === 'evolve'
                  ? 'Run GEPA'
                  : 'Run image'}
            </button>
          )}
        </>
      }
    >

      {loadError ? <div className="app-banner error">{loadError}</div> : null}
      {runError ? <div className="app-banner error">{runError}</div> : null}
      {runBlockedReason && !showGuide ? (
        <div className="app-banner warn">{runBlockedReason}</div>
      ) : null}

      <div
        className="app-body"
        style={
          {
            '--pane-config-width': `${configWidth}px`,
            '--pane-models-width': `${modelsWidth}px`,
          } as CSSProperties
        }
      >
        <aside className="app-pane app-pane-config">
          <div className="pane-label">Config</div>

          {mode === 'text' ? (
            <>
              <label className="field">
                <span>Dataset</span>
                <select value={datasetId} onChange={(e) => setDatasetId(e.target.value)}>
                  {datasets.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.label} · {d.metric}
                    </option>
                  ))}
                </select>
                {selectedDataset?.notes ? (
                  <span className="field-hint">{selectedDataset.notes}</span>
                ) : null}
              </label>

              <label className="field">
                <span>
                  Samples <strong>{sampleCount}</strong>
                </span>
                <div className="sample-presets">
                  {SAMPLE_PRESETS.map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={sampleCount === n ? 'on' : undefined}
                      onClick={() => setSampleCount(n)}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <input
                  type="range"
                  min={1}
                  max={200}
                  value={sampleCount}
                  onChange={(e) => setSampleCount(Number(e.target.value))}
                />
              </label>

              <p className="field-hint">
                Dual-eval small + large → outcome labels for routing-SLM training. See{' '}
                <a
                  href="https://github.com/savagemanage/redrob-eval/blob/main/docs/methodology.md"
                  target="_blank"
                  rel="noreferrer"
                >
                  docs/methodology.md
                </a>
                .
              </p>

              <div className="router-pair">
                <label className="field">
                  <span>Small</span>
                  <select
                    value={routerSmallId}
                    onChange={(e) => setRouterSmallId(e.target.value)}
                  >
                    {(smallOptions.length ? smallOptions : routerOptions).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Large (baseline)</span>
                  <select
                    value={routerLargeId}
                    onChange={(e) => setRouterLargeId(e.target.value)}
                  >
                    {(largeOptions.length ? largeOptions : routerOptions).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="field">
                <span>
                  Small-OK threshold <strong>{smallOkThreshold.toFixed(2)}</strong>
                </span>
                <input
                  type="range"
                  min={0.1}
                  max={1}
                  step={0.01}
                  value={smallOkThreshold}
                  onChange={(e) => setSmallOkThreshold(Number(e.target.value))}
                />
                <span className="field-hint">
                  Label small when small.score ≥ threshold; else large.
                </span>
              </label>

              <div className="selected-summary">
                <div className="pane-label">Routing corpus</div>
                {corpus ? (
                  <p className="field-hint">
                    {corpus.exampleCount} examples · {corpus.runCount} runs · small{' '}
                    {corpus.byLabel.small} / large {corpus.byLabel.large}
                  </p>
                ) : (
                  <p className="field-hint">No corpus yet — collect to start.</p>
                )}
                <div className="sample-presets" style={{ marginTop: '0.35rem' }}>
                  <a className="export-link" href="/api/routing/export?format=chat">
                    Export chat
                  </a>
                  <a className="export-link" href="/api/routing/export?format=flat">
                    Export flat
                  </a>
                </div>
              </div>

              <div className="selected-summary">
                <div className="pane-label">Past collections</div>
                {routingRuns.length === 0 ? (
                  <p className="field-hint">None yet</p>
                ) : (
                  <ul className="run-id-list">
                    {routingRuns.slice(0, 8).map(({ meta, summary }) => (
                      <li key={meta.runId}>
                        <code>{meta.runId}</code>
                        <span className="sub">
                          {meta.status}
                          {summary ? ` · save ${(summary.saveRate * 100).toFixed(0)}%` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          ) : mode === 'evolve' ? (
            <>
              <div className="sample-presets" style={{ marginBottom: '0.75rem' }}>
                <button
                  type="button"
                  className={evolveSource === 'catalog' ? 'on' : undefined}
                  onClick={() => setEvolveSource('catalog')}
                >
                  Catalog dataset
                </button>
                <button
                  type="button"
                  className={evolveSource === 'custom' ? 'on' : undefined}
                  onClick={() => setEvolveSource('custom')}
                >
                  Custom goal
                </button>
              </div>

              {evolveSource === 'catalog' ? (
                <>
                  <label className="field">
                    <span>Dataset</span>
                    <select value={datasetId} onChange={(e) => setDatasetId(e.target.value)}>
                      {datasets.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.label} · {d.metric}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="field">
                    <span>
                      Samples <strong>{sampleCount}</strong>
                    </span>
                    <div className="sample-presets">
                      {SAMPLE_PRESETS.map((n) => (
                        <button
                          key={n}
                          type="button"
                          className={sampleCount === n ? 'on' : undefined}
                          onClick={() => setSampleCount(n)}
                        >
                          {n}
                        </button>
                      ))}
                    </div>
                    <input
                      type="range"
                      min={5}
                      max={80}
                      value={Math.min(sampleCount, 80)}
                      onChange={(e) => setSampleCount(Number(e.target.value))}
                    />
                  </label>
                </>
              ) : (
                <>
                  <label className="field">
                    <span>Goal</span>
                    <textarea
                      rows={3}
                      value={customGoalText}
                      onChange={(e) => setCustomGoalText(e.target.value)}
                      placeholder="e.g. Write the best system prompt for evaluating a hiring candidate against a job description."
                      style={{ width: '100%', font: 'inherit', padding: '0.4rem' }}
                    />
                  </label>
                  <label className="field">
                    <span>Rubric</span>
                    <textarea
                      rows={4}
                      value={customRubric}
                      onChange={(e) => setCustomRubric(e.target.value)}
                      placeholder="What should the judge score? List criteria (clarity, evidence, bias, …)."
                      style={{ width: '100%', font: 'inherit', padding: '0.4rem' }}
                    />
                  </label>
                  <label className="field">
                    <span>Examples (JSONL or JSON array)</span>
                    <textarea
                      rows={6}
                      value={customExamplesRaw}
                      onChange={(e) => setCustomExamplesRaw(e.target.value)}
                      placeholder={'{"id":"1","input":"…"}\n{"id":"2","input":"…"}'}
                      style={{
                        width: '100%',
                        font: 'inherit',
                        padding: '0.4rem',
                        fontFamily: 'ui-monospace, monospace',
                        fontSize: '0.75rem',
                      }}
                    />
                    <span className="field-hint">
                      Input-only · 3–80 rows · scored by an LLM judge (can be gamed — use a strong
                      judge + floor you trust).
                    </span>
                  </label>
                  <label className="field">
                    <span>Judge model</span>
                    <select
                      value={evolveJudgeModelId || routerLargeId || routerSmallId}
                      onChange={(e) => setEvolveJudgeModelId(e.target.value)}
                    >
                      {routerOptions.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                    <span className="field-hint">
                      Scores each answer against your fixed goal + rubric (quality signal for GEPA).
                      Prefer a strong model; defaults to reflect if unset.
                    </span>
                  </label>
                </>
              )}

              <label className="field">
                <span>
                  Quality floor <strong>{qualityFloor.toFixed(2)}</strong>
                </span>
                <input
                  type="range"
                  min={0.1}
                  max={1}
                  step={0.01}
                  value={qualityFloor}
                  onChange={(e) => setQualityFloor(Number(e.target.value))}
                />
                <span className="field-hint">Below floor = infeasible (not a soft penalty).</span>
              </label>

              <label className="field">
                <span>
                  Max rollouts <strong>{maxRollouts}</strong>
                </span>
                <input
                  type="range"
                  min={4}
                  max={40}
                  value={maxRollouts}
                  onChange={(e) => setMaxRollouts(Number(e.target.value))}
                />
              </label>

              <label className="field">
                <span>
                  Minibatch <strong>{minibatchSize}</strong>
                </span>
                <input
                  type="range"
                  min={2}
                  max={12}
                  value={minibatchSize}
                  onChange={(e) => setMinibatchSize(Number(e.target.value))}
                />
              </label>

              <div className="router-pair">
                <label className="field">
                  <span>Seed model</span>
                  <select
                    value={routerSmallId}
                    onChange={(e) => setRouterSmallId(e.target.value)}
                  >
                    {routerOptions.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  <span className="field-hint">
                    Runs the candidate prompt on your examples (the model you are optimizing for).
                  </span>
                </label>
                <label className="field">
                  <span>Reflect model</span>
                  <select
                    value={routerLargeId || routerSmallId}
                    onChange={(e) => setRouterLargeId(e.target.value)}
                  >
                    {routerOptions.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  <span className="field-hint">
                    Meta-LLM: reads failures and rewrites the instruction (does not serve end users).
                    A stronger model often mutates better.
                  </span>
                </label>
              </div>

              <label className="field">
                <span>
                  Prompt budget <strong>{maxPromptTokens}</strong> tokens
                </span>
                <input
                  type="range"
                  min={256}
                  max={8192}
                  step={256}
                  value={maxPromptTokens}
                  onChange={(e) => setMaxPromptTokens(Number(e.target.value))}
                />
                <span className="field-hint">
                  Demos that do not fit are dropped (demos_requested vs demos_fitted).
                </span>
              </label>

              <label className="field">
                <span>Seed instruction</span>
                <textarea
                  rows={4}
                  value={evolveInstruction}
                  onChange={(e) => setEvolveInstruction(e.target.value)}
                  placeholder={
                    evolveSource === 'custom'
                      ? 'Optional — blank derives a seed from your goal'
                      : 'Optional — leave blank for a task default'
                  }
                  style={{ width: '100%', font: 'inherit', padding: '0.4rem' }}
                />
              </label>

              <p className="field-hint">
                GEPA evolves instruction / demos / model / script_policy under a quality floor,
                minimizing tokens. Seed runs the prompt; reflect rewrites it
                {evolveSource === 'custom' ? '; judge scores outputs vs your rubric' : ''}.
                Train+val only; test once at the end.
              </p>
            </>
          ) : (
            <>
              <label className="field">
                <span>Suite</span>
                <select value={suiteId} onChange={(e) => setSuiteId(e.target.value)}>
                  {imageSuites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label} · {s.promptCount} prompts
                    </option>
                  ))}
                </select>
                {selectedSuite?.description ? (
                  <span className="field-hint">{selectedSuite.description}</span>
                ) : null}
              </label>

              <label className="field">
                <span>
                  Prompts <strong>{promptLimit}</strong>
                </span>
                <div className="sample-presets">
                  {PROMPT_PRESETS.map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={promptLimit === n ? 'on' : undefined}
                      onClick={() => setPromptLimit(n)}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </label>

              <label className="field">
                <span>Seed</span>
                <input
                  type="number"
                  value={seed}
                  onChange={(e) => setSeed(Number(e.target.value) || 0)}
                />
              </label>

              <label className="toggle">
                <input
                  type="checkbox"
                  checked={autoJudge}
                  onChange={(e) => setAutoJudge(e.target.checked)}
                />
                <span>Vision LLM auto-judge</span>
              </label>

              {autoJudge ? (
                <label className="field">
                  <span>Judge model</span>
                  <input
                    type="text"
                    value={judgeModelId}
                    onChange={(e) => setJudgeModelId(e.target.value)}
                    placeholder="or/openai/gpt-4o"
                  />
                  <span className="field-hint">
                    Multimodal OpenRouter id. Prefills winner + prompt-adherence scores;
                    humans can override.
                  </span>
                </label>
              ) : null}

              <div className="selected-summary">
                <div className="pane-label">Image models</div>
                {selectedImageModels.length === 0 ? (
                  <p className="field-hint">Pick generators in the catalog →</p>
                ) : (
                  <ul>
                    {selectedImageModels.map((id) => (
                      <li key={id}>
                        <button
                          type="button"
                          onClick={() =>
                            setSelectedImageModels((prev) => prev.filter((x) => x !== id))
                          }
                          title="Remove"
                        >
                          {knownModels[id]?.label ?? id}
                          <span>×</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="selected-summary">
                <div className="pane-label">Past runs</div>
                {pastRuns.length === 0 ? (
                  <p className="field-hint">None yet</p>
                ) : (
                  <ul>
                    {pastRuns.slice(0, 8).map((r) => (
                      <li key={r.runId}>
                        <button
                          type="button"
                          onClick={() => setActiveImageRunId(r.runId)}
                          title="Open"
                        >
                          {r.runId}
                          <span>{r.status}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}

          <div className="providers-compact">
            <div className="pane-label">Providers</div>
            <ul>
              {status?.providers.map((p) => (
                <li key={p.id}>
                  <span>{p.label}</span>
                  <span className={p.configured ? 'ok' : 'miss'}>
                    {p.configured ? 'ready' : '—'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        <div
          className="pane-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize config panel"
          onPointerDown={(e) => startResize('config', e)}
        />

        <section className="app-pane app-pane-models">
          <ModelPicker
            selectedIds={mode === 'image' ? selectedImageModels : selectedModels}
            onChange={mode === 'image' ? setSelectedImageModels : setSelectedModels}
            knownModels={knownModels}
            onKnown={mergeKnown}
            fillHeight
            selectMode={mode === 'image' ? 'image' : 'text'}
          />
        </section>

        <div
          className="pane-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize models panel"
          onPointerDown={(e) => startResize('models', e)}
        />

        <section className="app-pane app-pane-results">
          <div className="pane-label">
            {mode === 'text'
              ? 'Routing collection'
              : mode === 'evolve'
                ? 'GEPA evolution'
                : 'Preference'}
          </div>

          {showGuide ? (
            <GettingStartedPanel
              mode={mode}
              canRun={canRun}
              openrouterReady={openrouterReady}
              configuredCount={configuredCount}
              providerTotal={status?.providers.length ?? 0}
              hasSmall={Boolean(routerSmallId)}
              hasLarge={Boolean(routerLargeId)}
              smallDiffersLarge={Boolean(
                routerSmallId && routerLargeId && routerSmallId !== routerLargeId,
              )}
              hasSeed={Boolean(routerSmallId)}
              hasImageModels={selectedImageModels.length > 0}
              runBlockedReason={runBlockedReason}
              sampleLoading={sampleLoading}
              onApplyStarter={applyStarterSettings}
              onLoadSampleReport={() => void loadSampleReport()}
              onSwitchMode={(m) => {
                const href =
                  m === 'compare'
                    ? '/compare'
                    : m === 'preference'
                      ? '/preference'
                      : `/${m}`;
                router.push(href);
              }}
              onDismiss={dismissGuide}
            />
          ) : null}

          {runProgress.length > 0 ? (
            <div className="run-progress">
              <div className="pane-label">Progress</div>
              <ul className="run-progress-list">
                {runProgress.map((row) => {
                  const pctDone =
                    row.total > 0 ? Math.round((row.done / row.total) * 100) : 0;
                  return (
                    <li key={row.id} data-status={row.status}>
                      <div className="run-progress-head">
                        <strong>{row.label}</strong>
                        <span>
                          {row.done}/{row.total}
                          {row.errors > 0 ? ` · ${row.errors} err` : ''}
                          {' · '}
                          {row.status}
                        </span>
                      </div>
                      <div className="run-progress-track">
                        <div
                          className="run-progress-bar"
                          style={{ width: `${pctDone}%` }}
                        />
                      </div>
                      {row.detail ? <p className="run-progress-detail">{row.detail}</p> : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          {mode === 'image' ? (
            <ImagePreferencePanel runId={activeImageRunId} />
          ) : mode === 'evolve' ? (
            <div className="results-stack">
              {frontierPoints.length > 0 || evolveHistory.length > 0 ? (
                <>
                  <div className="evolve-view-switch" role="tablist" aria-label="Evolve chart">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={evolveView === 'progress'}
                      className={evolveView === 'progress' ? 'on' : undefined}
                      onClick={() => setEvolveView('progress')}
                    >
                      Progress
                      {evolveHistory.length > 0
                        ? ` · ${evolveHistory.length}`
                        : ''}
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={evolveView === 'frontier'}
                      className={evolveView === 'frontier' ? 'on' : undefined}
                      onClick={() => setEvolveView('frontier')}
                    >
                      Frontier
                      {frontierPoints.length > 0
                        ? ` · ${frontierPoints.length}`
                        : ''}
                    </button>
                  </div>
                  {evolveView === 'progress' ? (
                    evolveHistory.length > 0 ? (
                      <EvolutionProgressChart
                        steps={evolveHistory}
                        qualityFloor={evolveReport?.qualityFloor ?? qualityFloor}
                      />
                    ) : (
                      <p className="empty">
                        Waiting for the first rollout… Progress plots quality over time as
                        candidates evaluate.
                      </p>
                    )
                  ) : frontierPoints.length > 0 ? (
                    <EvolutionParetoChart
                      points={frontierPoints}
                      highlightId={bestCandidate?.id}
                      baselineId={evolveReport?.baseline?.candidate?.id ?? null}
                      qualityFloor={evolveReport?.qualityFloor ?? qualityFloor}
                    />
                  ) : (
                    <p className="empty">
                      Frontier updates after rollouts. Switch to Progress to watch the run.
                    </p>
                  )}
                </>
              ) : (
                <>
                  <p className="field-hint">
                    Progress shows quality over rollout time. Frontier shows the final
                    quality-vs-tokens tradeoff. Prefer higher quality and fewer tokens.
                  </p>
                  <p className="empty">
                    {showGuide
                      ? 'Apply starter settings above, then Run GEPA — or Preview sample report (offline).'
                      : 'Open Guide for a sample workflow, or set quality floor + seed → Run GEPA.'}
                  </p>
                </>
              )}
              {evolveLesson ? (
                <p className="field-hint">
                  <strong>Lesson:</strong> {evolveLesson}
                </p>
              ) : null}
              {bestCandidate ? (
                <div className="selected-summary">
                  <div className="pane-label">Best feasible</div>
                  <p className="field-hint">
                    {bestCandidate.id} · {bestCandidate.model.modelId} · demos{' '}
                    {bestCandidate.demos.length}
                    {bestCandidate.scriptPolicies
                      ? ` · script ${bestCandidate.scriptPolicies.input}`
                      : ''}
                    {evolveTestQuality != null
                      ? ` · test ${pct(evolveTestQuality)}`
                      : ''}
                  </p>
                  <pre
                    style={{
                      whiteSpace: 'pre-wrap',
                      fontSize: '0.75rem',
                      maxHeight: '10rem',
                      overflow: 'auto',
                    }}
                  >
                    {bestCandidate.instruction}
                  </pre>
                </div>
              ) : null}
              {evolveReport ? (
                <div className="selected-summary">
                  <div className="pane-label">Baseline vs evolved</div>
                  <p className="field-hint">
                    Val quality {evolveReport.baseline.val?.quality != null
                      ? pct(evolveReport.baseline.val.quality)
                      : '—'}{' '}
                    →{' '}
                    {evolveReport.evolved.val?.quality != null
                      ? pct(evolveReport.evolved.val.quality)
                      : '—'}
                    {evolveReport.qualityDeltaVal != null
                      ? ` (Δ ${evolveReport.qualityDeltaVal >= 0 ? '+' : ''}${evolveReport.qualityDeltaVal.toFixed(3)})`
                      : ''}
                  </p>
                  <p className="field-hint">
                    Val tokens {evolveReport.baseline.val?.totalTokens ?? '—'} →{' '}
                    {evolveReport.evolved.val?.totalTokens ?? '—'}
                    {evolveReport.tokenDelta != null
                      ? ` (Δ ${evolveReport.tokenDelta >= 0 ? '+' : ''}${evolveReport.tokenDelta})`
                      : ''}
                    {evolveReport.relativeCostPct != null
                      ? ` · rel. cost ${evolveReport.relativeCostPct.toFixed(1)}% of baseline`
                      : ''}
                  </p>
                  <p className="field-hint">
                    Demos fitted {evolveReport.demos.baselineFitted}/
                    {evolveReport.demos.baselineRequested} →{' '}
                    {evolveReport.demos.evolvedFitted}/
                    {evolveReport.demos.evolvedRequested}
                  </p>
                  {activeOptRunRef.current || evolveReport.runId ? (
                    <p className="field-hint">
                      <a
                        href={`/api/optimize/runs/${encodeURIComponent(evolveReport.runId)}?export=md`}
                        download
                      >
                        Download report.md
                      </a>
                      {' · '}
                      <a
                        href={`/api/optimize/runs/${encodeURIComponent(evolveReport.runId)}?export=json`}
                        download
                      >
                        report.json
                      </a>
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : displayTargets.length === 0 && runProgress.length === 0 ? (
            <p className="empty">
              {showGuide
                ? 'Apply starter settings above, then Collect routing data.'
                : 'Open Guide for a sample workflow, or pick small/large → Collect routing data.'}
            </p>
          ) : displayTargets.length === 0 ? null : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Target</th>
                    <th>Quality</th>
                    <th>Rel. cost</th>
                    <th>vs large</th>
                    <th>Latency</th>
                    <th>Routing</th>
                  </tr>
                </thead>
                <tbody>
                  {displayTargets.map((t) => (
                    <tr key={t.targetId} data-kind={t.kind}>
                      <td>
                        <strong>{t.label}</strong>
                        <span className="sub">{t.kind}</span>
                      </td>
                      <td>{pct(t.quality)}</td>
                      <td>{t.relativeCostPct.toFixed(1)}%</td>
                      <td>
                        {t.qualityRetention != null ? pct(t.qualityRetention) : '—'}
                      </td>
                      <td>{fmtMs(t.meanLatencyMs)}</td>
                      <td>
                        {t.kind === 'router'
                          ? t.routingOracleAccuracy != null
                            ? `oracle ${pct(t.routingOracleAccuracy)}`
                            : t.routingPolicyAccuracy != null
                              ? `policy ${pct(t.routingPolicyAccuracy)}`
                              : '—'
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {mode === 'text' && result ? (
            <div className="results-extra">
              <div className="pane-label">Pareto</div>
              <ParetoChart result={result} />
              {result.routingLog.length > 0 ? (
                <>
                  <div className="pane-label">Routing log</div>
                  <div className="table-scroll log">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Sample</th>
                          <th>Complexity</th>
                          <th>Tier</th>
                          <th>Model</th>
                          <th>Why</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.routingLog.map((r) => (
                          <tr key={`${r.sampleId}-${r.chosenModelId}`}>
                            <td className="mono">{r.sampleId}</td>
                            <td>
                              {r.complexity}{' '}
                              <span className="sub">{r.complexityScore.toFixed(2)}</span>
                            </td>
                            <td>{r.chosenTier}</td>
                            <td>{r.chosenModelLabel}</td>
                            <td>{r.reasons.join(', ')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>
    </AppShell>
  );
}
