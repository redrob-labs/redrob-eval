'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import type { CatalogModel } from '@/components/ModelPicker';
import { takeComparePrompts } from '@/lib/handoff';
import { PreferenceStage } from './PreferenceStage';
import { RouteStage } from './RouteStage';
import { RunStage } from './RunStage';
import { SetupStage } from './SetupStage';
import {
  parsePrompts,
  STAGE_LABELS,
  STAGE_ORDER,
  type CompareSetup,
  type CompareStage,
  type DatasetInfo,
  type EvalRunResult,
  type EvalStreamEvent,
  type EvalTargetSummary,
  type RoutePolicyResult,
  type SuiteInfo,
  type TournamentState,
  type VoteWinner,
} from './types';

const INITIAL_SETUP: CompareSetup = {
  modality: 'text',
  modelIds: [],
  taskSource: 'dataset',
  datasetId: '',
  suiteId: '',
  sampleCount: 10,
  customPromptsRaw: '',
  promptSetLabel: '',
};

/**
 * Compare is the one place any model from any source gets compared on any
 * modality. Setup picks what to run, Run measures it live, Preference resolves
 * quality by blind human votes, and Optimize route turns those votes into a
 * routing policy.
 */
export function CompareApp() {
  const [stage, setStage] = useState<CompareStage>('setup');
  const [setup, setSetup] = useState<CompareSetup>(INITIAL_SETUP);
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
  const [suites, setSuites] = useState<SuiteInfo[]>([]);
  const [knownModels, setKnownModels] = useState<Record<string, CatalogModel>>({});

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [targets, setTargets] = useState<EvalTargetSummary[]>([]);
  const [result, setResult] = useState<EvalRunResult | null>(null);
  const [scored, setScored] = useState(true);
  const [runError, setRunError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [tournament, setTournament] = useState<TournamentState | null>(null);
  const [tournamentStarting, setTournamentStarting] = useState(false);
  const [tournamentError, setTournamentError] = useState<string | null>(null);

  const mergeKnown = useCallback((models: CatalogModel[]) => {
    setKnownModels((prev) => {
      const next = { ...prev };
      for (const m of models) next[m.id] = m;
      return next;
    });
  }, []);

  /** Switching modality invalidates the model picks: an image generator cannot chat. */
  const patchSetup = useCallback((patch: Partial<CompareSetup>) => {
    setSetup((prev) => {
      const next = { ...prev, ...patch };
      if (patch.modality && patch.modality !== prev.modality) {
        next.modelIds = [];
      }
      return next;
    });
  }, []);

  /**
   * A set handed over by Generate. Read before the catalog fetch so the prompts are in
   * place by the time anything else touches setup, and applied only when the reader has
   * not already typed something of their own.
   */
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const handoff = takeComparePrompts();
      if (!handoff) return;
      setSetup((prev) =>
        prev.customPromptsRaw
          ? prev
          : {
              ...prev,
              taskSource: 'custom',
              customPromptsRaw: JSON.stringify(handoff.prompts, null, 2),
              promptSetLabel: handoff.label,
            },
      );
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [dRes, sRes, mRes] = await Promise.all([
          fetch('/api/datasets'),
          fetch('/api/image/suites'),
          fetch('/api/models?source=curated&limit=100'),
        ]);
        const dJson = (await dRes.json()) as { datasets?: DatasetInfo[] };
        const sJson = (await sRes.json()) as { suites?: SuiteInfo[] };
        const mJson = (await mRes.json()) as { models?: CatalogModel[] };
        if (cancelled) return;
        const ds = dJson.datasets ?? [];
        const su = sJson.suites ?? [];
        setDatasets(ds);
        setSuites(su);
        mergeKnown(mJson.models ?? []);
        const callables = (mJson.models ?? []).filter((m) => m.callable);
        setSetup((prev) => ({
          ...prev,
          datasetId: prev.datasetId || (ds[0]?.id ?? ''),
          suiteId: prev.suiteId || (su[0]?.id ?? ''),
          modelIds: prev.modelIds.length
            ? prev.modelIds
            : callables.slice(0, 2).map((m) => m.id),
        }));
      } catch {
        // ModelPicker still loads the catalog on its own
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mergeKnown]);

  const startRun = useCallback(async () => {
    const ac = new AbortController();
    abortRef.current = ac;
    setRunning(true);
    setRunError(null);
    setTargets([]);
    setResult(null);
    setProgress(null);
    setStage('run');

    const custom = setup.taskSource === 'custom' ? parsePrompts(setup.customPromptsRaw) : null;
    const body =
      custom && custom.prompts.length
        ? {
            modality: setup.modality,
            prompts: custom.prompts,
            promptSetLabel: setup.promptSetLabel || 'Custom prompts',
            sampleCount: custom.prompts.length,
            modelIds: setup.modelIds,
          }
        : {
            modality: setup.modality,
            datasetId: setup.modality === 'image' ? undefined : setup.datasetId,
            suiteId: setup.suiteId,
            sampleCount: setup.sampleCount,
            modelIds: setup.modelIds,
          };

    try {
      const res = await fetch('/api/compare/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ac.signal,
        body: JSON.stringify(body),
      });
      if (!res.ok || !res.body) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `HTTP ${res.status}`);
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
          const line = chunk
            .split('\n')
            .map((l) => l.trim())
            .find((l) => l.startsWith('data:'));
          if (!line) continue;
          const event = JSON.parse(line.slice(5).trim()) as EvalStreamEvent;
          if (event.type === 'start') {
            setProgress({ done: 0, total: event.totalCalls });
            setScored(event.scored !== false);
          } else if (event.type === 'progress') {
            setProgress({ done: event.done, total: event.total });
          } else if (event.type === 'target_done') {
            setTargets((prev) => [...prev, event.target]);
          } else if (event.type === 'done') {
            setResult(event.result);
            setScored(event.result.meta.scored !== false);
          } else if (event.type === 'error') {
            setRunError(event.message);
          }
        }
      }
    } catch (e) {
      if (!(e instanceof Error && e.name === 'AbortError')) {
        setRunError(e instanceof Error ? e.message : 'Run failed');
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  }, [setup]);

  const stopRun = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const startTournament = useCallback(async () => {
    if (!result) return;
    setTournamentStarting(true);
    setTournamentError(null);
    try {
      const prompts =
        result.meta.prompts ??
        result.targets[0]?.sampleResults.map((s) => ({ id: s.sampleId, text: s.sampleId })) ??
        [];
      const res = await fetch('/api/compare/tournament', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceRunId: result.meta.runId,
          modality: setup.modality,
          prompts: prompts.map((p) => ({
            id: p.id,
            text: 'text' in p ? p.text : p.input,
          })),
          answers: result.targets
            .filter((t) => t.kind === 'model')
            .map((t) => ({
              modelId: t.targetId,
              label: t.label,
              byPromptId: Object.fromEntries(
                t.sampleResults.map((s) => [
                  s.sampleId,
                  { answer: s.prediction, error: s.error },
                ]),
              ),
            })),
        }),
      });
      const json = (await res.json()) as TournamentState & { error?: string };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setTournament(json);
    } catch (e) {
      setTournamentError(e instanceof Error ? e.message : 'Could not build brackets');
    } finally {
      setTournamentStarting(false);
    }
  }, [result, setup.modality]);

  const castVote = useCallback(
    async (promptId: string, matchId: string, winner: VoteWinner) => {
      if (!tournament) return;
      setTournamentError(null);
      try {
        const res = await fetch(
          `/api/compare/tournament/${encodeURIComponent(tournament.meta.runId)}/vote`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ promptId, matchId, winner }),
          },
        );
        const json = (await res.json()) as TournamentState & { error?: string };
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        setTournament(json);
      } catch (e) {
        setTournamentError(e instanceof Error ? e.message : 'Vote failed');
      }
    },
    [tournament],
  );

  const judgeMatch = useCallback(
    async (promptId: string, matchId: string) => {
      if (!tournament) return;
      setTournamentError(null);
      try {
        const res = await fetch(
          `/api/compare/tournament/${encodeURIComponent(tournament.meta.runId)}/judge`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ promptId, matchId }),
          },
        );
        const json = (await res.json()) as TournamentState & { error?: string };
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        setTournament(json);
      } catch (e) {
        setTournamentError(e instanceof Error ? e.message : 'Judge failed');
      }
    },
    [tournament],
  );

  const derivePolicy = useCallback(
    async (
      smallModelId: string,
      largeModelId: string,
      save: boolean,
    ): Promise<RoutePolicyResult | null> => {
      if (!tournament) return null;
      const res = await fetch(
        `/api/compare/tournament/${encodeURIComponent(tournament.meta.runId)}/route-policy`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ smallModelId, largeModelId, save }),
        },
      );
      const json = (await res.json()) as RoutePolicyResult & { error?: string };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      return json;
    },
    [tournament],
  );

  const reachableStages = useMemo(() => {
    const set = new Set<CompareStage>(['setup']);
    if (running || result) set.add('run');
    if (result) set.add('preference');
    if (tournament?.meta.finishedAt) set.add('route');
    return set;
  }, [running, result, tournament]);

  return (
    <AppShell
      module="compare"
      center={
        <nav className="cmp-stages" aria-label="Compare stages">
          {STAGE_ORDER.map((s, i) => (
            <button
              key={s}
              type="button"
              className={`cmp-stage${stage === s ? ' on' : ''}`}
              disabled={!reachableStages.has(s)}
              onClick={() => setStage(s)}
            >
              <span className="cmp-stage-n">{i + 1}</span>
              {STAGE_LABELS[s]}
            </button>
          ))}
        </nav>
      }
    >
      <main className="cmp-page">
        {stage === 'setup' ? (
          <SetupStage
            setup={setup}
            onChange={patchSetup}
            datasets={datasets}
            suites={suites}
            knownModels={knownModels}
            onKnown={mergeKnown}
            onStart={() => void startRun()}
            starting={running}
          />
        ) : null}

        {stage === 'run' ? (
          <RunStage
            running={running}
            progress={progress}
            targets={targets}
            result={result}
            scored={scored}
            error={runError}
            onStop={stopRun}
            onBackToSetup={() => setStage('setup')}
            onStartPreference={() => setStage('preference')}
            preferenceReady={(result?.targets.length ?? 0) >= 2}
          />
        ) : null}

        {stage === 'preference' ? (
          <PreferenceStage
            modality={setup.modality}
            state={tournament}
            starting={tournamentStarting}
            error={tournamentError}
            onStart={() => void startTournament()}
            onVote={castVote}
            onJudge={setup.modality === 'image' ? judgeMatch : undefined}
            onOptimizeRoute={() => setStage('route')}
          />
        ) : null}

        {stage === 'route' ? (
          <RouteStage
            state={tournament}
            onDerive={derivePolicy}
            onBack={() => setStage('preference')}
          />
        ) : null}
      </main>
    </AppShell>
  );
}
