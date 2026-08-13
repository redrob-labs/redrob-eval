"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { useT } from "@/components/LocaleProvider";
import type { CatalogModel } from "@/components/ModelPicker";
import type { MessageKey } from "@/lib/i18n";
import { takeComparePrompts } from "@/lib/handoff";
import { COMPARE_IMAGE_UI_ENABLED } from "@/lib/compare/features";
import { readSseJson } from "@/lib/sse";
import { CompareReports } from "./CompareReports";
import { PreferenceStage } from "./PreferenceStage";
import { RouteStage } from "./RouteStage";
import { RunStage } from "./RunStage";
import { SetupStage } from "./SetupStage";
import type { ToolRoutingLogLine } from "./ToolRoutingProgressLog";
import { ToolRoutingRunStage } from "./ToolRoutingRunStage";
import type { ToolRoutingModelResult, ToolRoutingReport } from "./tool-routing";
import {
  buildEvalReport,
  buildToolReport,
  upsertReport,
} from "@/lib/compare/report-store";
import {
  parsePrompts,
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
} from "./types";

const STAGE_KEYS: Record<CompareStage, MessageKey> = {
  setup: "compare.stage.setup",
  preference: "compare.stage.preference",
  route: "compare.stage.route",
};

/** The one condition every provider can run, so the ballot is a fair pairing. */
const BALLOT_CONDITION = "contract";

const INITIAL_SETUP: CompareSetup = {
  modality: "text",
  modelIds: [],
  taskSource: "dataset",
  datasetId: "",
  suiteId: "",
  sampleCount: 10,
  customPromptsRaw: "",
  promptSetLabel: "",
  vllmHostId: "",
  toolLanguageIds: ["en", "hi", "hi-Latn", "ko"],
};

/**
 * Compare is the one place any model from any source gets compared on any
 * modality. Setup picks what to run and shows the run streaming beside it,
 * Preference resolves quality by blind human votes, and Optimize route turns
 * those votes into a routing policy. Tool routing is one of the tasks and takes
 * the same stages; its grader decides the score, the votes decide the labels.
 */
export function CompareApp() {
  const t = useT();
  const [stage, setStage] = useState<CompareStage>("setup");
  const [setup, setSetup] = useState<CompareSetup>(INITIAL_SETUP);
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
  const [suites, setSuites] = useState<SuiteInfo[]>([]);
  const [knownModels, setKnownModels] = useState<Record<string, CatalogModel>>(
    {},
  );

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [targets, setTargets] = useState<EvalTargetSummary[]>([]);
  /** Per-target progress samples, so the ranking table fills in live per model. */
  const [liveByTarget, setLiveByTarget] = useState<
    Record<
      string,
      {
        label: string;
        kind: "model" | "router";
        samples: Array<{
          sampleId: string;
          score?: number;
          latencyMs?: number;
          prediction?: string;
          error?: string;
        }>;
      }
    >
  >({});
  const [result, setResult] = useState<EvalRunResult | null>(null);
  const [registryRunId, setRegistryRunId] = useState<string | null>(null);
  const [scored, setScored] = useState(true);
  const [runError, setRunError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [toolResults, setToolResults] = useState<ToolRoutingModelResult[]>([]);
  /** Ballots for the tool tasks, sent once at run start so votes can show them. */
  const [toolTasks, setToolTasks] = useState<
    Array<{ id: string; text: string }>
  >([]);
  const [toolProgress, setToolProgress] = useState<{
    done: number;
    total: number;
  }>({
    done: 0,
    total: 0,
  });
  const [toolLog, setToolLog] = useState<ToolRoutingLogLine[]>([]);
  const toolLogSeq = useRef(0);

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
  const patchSetup = useCallback(
    (patch: Partial<CompareSetup>) => {
      setSetup((prev) => {
        const next = { ...prev, ...patch };
        if (patch.modality && patch.modality !== prev.modality) {
          next.modelIds = [];
          // Tool routing is a text task; an image suite has no tools to route to.
          if (patch.modality === "image" && next.taskSource === "tool") {
            next.taskSource = "dataset";
          }
        }
        // A generated handoff's metric and provenance describe those exact
        // prompts. Once the reader edits the prompt box, keeping either would
        // attach the old template to a different benchmark.
        if (
          patch.customPromptsRaw !== undefined &&
          patch.customPromptsRaw !== prev.customPromptsRaw
        ) {
          next.promptMetric = undefined;
          next.promptProvenance = undefined;
        }
        return next;
      });
      const switchedTask =
        patch.taskSource && patch.taskSource !== setup.taskSource;
      if (
        (patch.modality && patch.modality !== setup.modality) ||
        switchedTask
      ) {
        setStage("setup");
        setToolResults([]);
        setResult(null);
        setRegistryRunId(null);
        setRunError(null);
      }
    },
    [setup.modality, setup.taskSource],
  );

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
              taskSource: "custom",
              customPromptsRaw: JSON.stringify(handoff.prompts, null, 2),
              promptSetLabel: handoff.label,
              promptMetric: handoff.metric,
              promptProvenance: handoff.provenance,
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
          fetch("/api/datasets"),
          COMPARE_IMAGE_UI_ENABLED
            ? fetch("/api/image/suites")
            : Promise.resolve(new Response(JSON.stringify({ suites: [] }))),
          fetch("/api/models?source=curated&limit=100"),
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
        // Unique by id, since self-hosted rows all point at the one endpoint.
        const defaultIds: string[] = [];
        for (const m of callables) {
          if (defaultIds.includes(m.id)) continue;
          defaultIds.push(m.id);
          if (defaultIds.length >= 2) break;
        }
        setSetup((prev) => ({
          ...prev,
          datasetId: prev.datasetId || (ds[0]?.id ?? ""),
          suiteId: prev.suiteId || (su[0]?.id ?? ""),
          modelIds: prev.modelIds.length
            ? [...new Set(prev.modelIds)]
            : defaultIds,
        }));
      } catch {
        // ModelPicker still loads the catalog on its own
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mergeKnown]);

  const startToolRun = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setRunning(true);
    setRunError(null);
    setToolResults([]);
    setToolTasks([]);
    setTournament(null);
    setToolProgress({ done: 0, total: 0 });
    setToolLog([]);

    // Mirror of the streamed per-model results, so the run can be saved to the
    // Reports shelf from the finally block without racing React state.
    const collected: ToolRoutingModelResult[] = [];

    // The counter is never reset, even though the log is cleared: aborting the
    // previous stream does not stop its loop at once, and a restarted counter
    // would hand both runs the same line ids.
    const pushLog = (text: string) => {
      if (abortRef.current !== ac) return;
      toolLogSeq.current += 1;
      const id = `r-${toolLogSeq.current}`;
      setToolLog((prev) => [...prev.slice(-120), { id, text }]);
    };

    type RunStreamEvent =
      | {
          type: "start";
          total: number;
          models: Array<{ id: string; label: string }>;
          tasks: Array<{ id: string; text: string }>;
        }
      | { type: "progress"; done: number; total: number; message: string }
      | {
          type: "model_done";
          modelId: string;
          label: string;
          report: ToolRoutingReport;
        }
      | { type: "model_error"; modelId: string; label: string; message: string }
      | { type: "done" }
      | { type: "error"; message: string };

    try {
      const res = await fetch("/api/tool-routing/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ac.signal,
        body: JSON.stringify({
          modelIds: setup.modelIds,
          hostId: setup.vllmHostId,
          languages: setup.toolLanguageIds,
        }),
      });
      if (!res.ok || !res.body) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }

      for await (const event of readSseJson<RunStreamEvent>(
        res.body,
        ac.signal,
      )) {
        if (abortRef.current !== ac) break;
        if (event.type === "start") {
          setToolProgress({ done: 0, total: event.total });
          setToolTasks(event.tasks ?? []);
          pushLog(
            t("compare.tool.log.runStart", {
              models: event.models.map((m) => m.label).join(", "),
              total: event.total,
            }),
          );
        } else if (event.type === "progress") {
          setToolProgress({ done: event.done, total: event.total });
          pushLog(`${event.done}/${event.total} ${event.message}`);
        } else if (event.type === "model_done") {
          const row: ToolRoutingModelResult = {
            modelId: event.modelId,
            label: event.label,
            report: event.report,
            error: null,
          };
          collected.push(row);
          setToolResults((prev) => [...prev, row]);
          pushLog(t("compare.tool.log.modelDone", { label: event.label }));
        } else if (event.type === "model_error") {
          const row: ToolRoutingModelResult = {
            modelId: event.modelId,
            label: event.label,
            report: null,
            error: event.message,
          };
          collected.push(row);
          setToolResults((prev) => [...prev, row]);
          pushLog(t("compare.tool.log.modelFailed", { label: event.label }));
        } else if (event.type === "done") {
          setToolProgress((p) => ({ done: p.total, total: p.total }));
          pushLog(t("compare.tool.log.runDone"));
        } else if (event.type === "error") {
          throw new Error(event.message);
        }
      }
    } catch (e) {
      const superseded = abortRef.current !== ac;
      if (!superseded && !(e instanceof Error && e.name === "AbortError")) {
        setRunError(
          e instanceof Error ? e.message : t("compare.tool.error.run"),
        );
      }
    } finally {
      if (abortRef.current === ac) {
        abortRef.current = null;
        setRunning(false);
        // Whatever answered is worth stacking, even a run that erred partway.
        const report = buildToolReport(collected, setup.toolLanguageIds);
        if (report) upsertReport(report);
      }
    }
  }, [setup.modelIds, setup.toolLanguageIds, setup.vllmHostId, t]);

  const startRun = useCallback(async () => {
    if (setup.taskSource === "tool") {
      await startToolRun();
      return;
    }

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setRunning(true);
    setRunError(null);
    setTargets([]);
    setLiveByTarget({});
    setResult(null);
    setRegistryRunId(null);
    setToolResults([]);
    setProgress(null);

    const custom =
      setup.taskSource === "custom"
        ? parsePrompts(setup.customPromptsRaw)
        : null;
    const body =
      custom && custom.prompts.length
        ? {
            modality: setup.modality,
            prompts: custom.prompts,
            promptSetLabel: setup.promptSetLabel || "Custom prompts",
            promptMetric: setup.promptMetric,
            promptProvenance: setup.promptProvenance,
            sampleCount: custom.prompts.length,
            modelIds: setup.modelIds,
          }
        : {
            modality: setup.modality,
            datasetId: setup.modality === "image" ? undefined : setup.datasetId,
            suiteId: setup.suiteId,
            sampleCount: setup.sampleCount,
            modelIds: setup.modelIds,
          };

    try {
      const res = await fetch("/api/compare/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ac.signal,
        body: JSON.stringify(body),
      });
      if (!res.ok || !res.body) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done || abortRef.current !== ac) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const line = chunk
            .split("\n")
            .map((l) => l.trim())
            .find((l) => l.startsWith("data:"));
          if (!line) continue;
          const event = JSON.parse(line.slice(5).trim()) as EvalStreamEvent;
          if (event.type === "start") {
            setRegistryRunId(event.registryRunId ?? null);
            setProgress({ done: 0, total: event.totalCalls });
            setScored(event.scored !== false);
            const seed: typeof liveByTarget = {};
            for (const tgt of event.targets) {
              seed[tgt.targetId] = {
                label: tgt.label,
                kind: tgt.kind,
                samples: [],
              };
            }
            setLiveByTarget(seed);
          } else if (event.type === "progress") {
            setProgress({ done: event.done, total: event.total });
            setLiveByTarget((prev) => {
              const cur = prev[event.targetId];
              if (!cur) return prev;
              return {
                ...prev,
                [event.targetId]: {
                  ...cur,
                  samples: [
                    ...cur.samples,
                    {
                      sampleId: event.sampleId,
                      score: event.score,
                      latencyMs: event.latencyMs,
                      prediction: event.prediction,
                      error: event.error,
                    },
                  ],
                },
              };
            });
          } else if (event.type === "target_done") {
            setTargets((prev) => [...prev, event.target]);
            setLiveByTarget((prev) => {
              if (!prev[event.target.targetId]) return prev;
              const next = { ...prev };
              delete next[event.target.targetId];
              return next;
            });
          } else if (event.type === "done") {
            setResult(event.result);
            setRegistryRunId(event.registryRunId ?? null);
            setScored(event.result.meta.scored !== false);
            upsertReport(buildEvalReport(event.result));
          } else if (event.type === "error") {
            setRunError(event.message);
          }
        }
      }
    } catch (e) {
      const superseded = abortRef.current !== ac;
      if (!superseded && !(e instanceof Error && e.name === "AbortError")) {
        setRunError(e instanceof Error ? e.message : "Run failed");
      }
    } finally {
      if (abortRef.current === ac) {
        abortRef.current = null;
        setRunning(false);
      }
    }
  }, [setup, startToolRun]);

  const stopRun = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /** Finished targets plus a live partial row per model still running. */
  const runTargets = useMemo<EvalTargetSummary[]>(() => {
    const mean = (xs: number[]) =>
      xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    const partials = Object.entries(liveByTarget)
      .filter(([, v]) => v.samples.length > 0)
      .map<EvalTargetSummary>(([targetId, v]) => {
        const scores = v.samples
          .map((s) => s.score)
          .filter((s): s is number => typeof s === "number");
        const lats = v.samples
          .map((s) => s.latencyMs)
          .filter((s): s is number => typeof s === "number");
        return {
          targetId,
          label: v.label,
          kind: v.kind,
          metric: "",
          n: v.samples.length,
          quality: mean(scores),
          meanLatencyMs: mean(lats),
          meanTtftMs: null,
          tokensPerSec: null,
          sampleResults: v.samples.map((s) => ({
            sampleId: s.sampleId,
            score: s.score ?? 0,
            latencyMs: s.latencyMs ?? 0,
            prediction: s.prediction ?? "",
            error: s.error,
          })),
          partial: true,
        };
      });
    return [...targets, ...partials];
  }, [targets, liveByTarget]);

  /**
   * Build the ballots from a tool-routing run.
   *
   * Compare runs contract only, so every stored answer is eligible. Keep the
   * filter below for legacy reports that may also contain bare examples.
   */
  const startToolTournament = useCallback(async () => {
    const usable = toolResults.filter((r) => r.report?.examples?.length);
    if (usable.length < 2 || toolTasks.length === 0) {
      setTournamentError(t("compare.tool.pref.needTwo"));
      return;
    }
    setTournamentStarting(true);
    setTournamentError(null);
    try {
      const answers = usable.map((r) => {
        const rows = r.report!.examples!.filter(
          (e) => e.condition === BALLOT_CONDITION,
        );
        return {
          modelId: r.modelId,
          label: r.label,
          byPromptId: Object.fromEntries(
            rows.map((e) => [e.taskId, { answer: e.raw, error: e.error }]),
          ),
        };
      });
      const res = await fetch("/api/compare/tournament", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceRunId: `tool-${usable[0]!.report!.createdAt}`,
          modality: "text",
          prompts: toolTasks,
          answers,
        }),
      });
      const json = (await res.json()) as TournamentState & { error?: string };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setTournament(json);
    } catch (e) {
      setTournamentError(
        e instanceof Error ? e.message : "Could not build brackets",
      );
    } finally {
      setTournamentStarting(false);
    }
  }, [t, toolResults, toolTasks]);

  const startTournament = useCallback(async () => {
    if (!result) return;
    setTournamentStarting(true);
    setTournamentError(null);
    try {
      const prompts =
        result.meta.prompts ??
        result.targets[0]?.sampleResults.map((s) => ({
          id: s.sampleId,
          text: s.sampleId,
        })) ??
        [];
      const res = await fetch("/api/compare/tournament", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceRunId: result.meta.runId,
          modality: setup.modality,
          prompts: prompts.map((p) => ({
            id: p.id,
            text: "text" in p ? p.text : p.input,
          })),
          answers: result.targets
            .filter((t) => t.kind === "model")
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
      setTournamentError(
        e instanceof Error ? e.message : "Could not build brackets",
      );
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
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ promptId, matchId, winner }),
          },
        );
        const json = (await res.json()) as TournamentState & { error?: string };
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        setTournament(json);
      } catch (e) {
        setTournamentError(e instanceof Error ? e.message : "Vote failed");
      }
    },
    [tournament],
  );

  /**
   * Every way of settling a group ballot posts to the same endpoint; what is in
   * the body is what the voter actually said, and the harness turns each into
   * the pairwise votes it justifies.
   */
  const postGroupBallot = useCallback(
    async (
      promptId: string,
      matchId: string,
      decision: Record<string, unknown>,
    ) => {
      if (!tournament) return;
      setTournamentError(null);
      try {
        const res = await fetch(
          `/api/compare/tournament/${encodeURIComponent(tournament.meta.runId)}/vote`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ promptId, matchId, ...decision }),
          },
        );
        const json = (await res.json()) as TournamentState & { error?: string };
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        setTournament(json);
      } catch (e) {
        setTournamentError(e instanceof Error ? e.message : "Vote failed");
      }
    },
    [tournament],
  );

  const castGroupVote = useCallback(
    (promptId: string, matchId: string, winnerModelId: string | null) =>
      postGroupBallot(promptId, matchId, { winnerModelId }),
    [postGroupBallot],
  );

  const eliminateFromBallot = useCallback(
    (promptId: string, matchId: string, modelId: string) =>
      postGroupBallot(promptId, matchId, { eliminateModelId: modelId }),
    [postGroupBallot],
  );

  const rankBallot = useCallback(
    (promptId: string, matchId: string, ranking: string[]) =>
      postGroupBallot(promptId, matchId, { ranking }),
    [postGroupBallot],
  );

  /** Clear one prompt so it can be voted again; the rest of the run is untouched. */
  const revotePrompt = useCallback(
    async (promptId: string) => {
      if (!tournament) return;
      setTournamentError(null);
      try {
        const res = await fetch(
          `/api/compare/tournament/${encodeURIComponent(tournament.meta.runId)}/undo`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ promptId }),
          },
        );
        const json = (await res.json()) as TournamentState & { error?: string };
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        setTournament(json);
      } catch (e) {
        setTournamentError(
          e instanceof Error ? e.message : "Could not clear that prompt",
        );
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
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ promptId, matchId }),
          },
        );
        const json = (await res.json()) as TournamentState & { error?: string };
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        setTournament(json);
      } catch (e) {
        setTournamentError(e instanceof Error ? e.message : "Judge failed");
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
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ smallModelId, largeModelId, save }),
        },
      );
      const json = (await res.json()) as RoutePolicyResult & { error?: string };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      return json;
    },
    [tournament],
  );

  const isTool = setup.taskSource === "tool";

  /** Two models have to have answered before there is anything to vote between. */
  const toolBallotReady = useMemo(
    () => toolResults.filter((r) => r.report?.examples?.length).length >= 2,
    [toolResults],
  );

  const reachableStages = useMemo(() => {
    const set = new Set<CompareStage>(["setup"]);
    if (isTool ? toolBallotReady : Boolean(result)) set.add("preference");
    if (tournament?.meta.finishedAt) set.add("route");
    return set;
  }, [result, tournament, isTool, toolBallotReady]);

  return (
    <AppShell
      module="compare"
      center={
        <nav className="cmp-stages" aria-label={t("compare.stagesAria")}>
          {STAGE_ORDER.map((s, i) => (
            <button
              key={s}
              type="button"
              className={`cmp-stage${stage === s ? " on" : ""}`}
              disabled={!reachableStages.has(s)}
              onClick={() => setStage(s)}
            >
              <span className="cmp-stage-n">{i + 1}</span>
              {t(STAGE_KEYS[s])}
            </button>
          ))}
        </nav>
      }
    >
      <main className={`cmp-page${stage === "setup" ? " cmp-page-wide" : ""}`}>
        {stage === "setup" ? (
          <SetupStage
            setup={setup}
            onChange={patchSetup}
            datasets={datasets}
            suites={suites}
            knownModels={knownModels}
            onKnown={mergeKnown}
            onStart={() => void startRun()}
            starting={running}
            runPane={
              isTool ? (
                <ToolRoutingRunStage
                  running={running}
                  progress={toolProgress}
                  log={toolLog}
                  results={toolResults}
                  error={runError}
                  onStop={stopRun}
                  onStartPreference={() => setStage("preference")}
                  preferenceReady={toolBallotReady}
                />
              ) : (
                <RunStage
                  running={running}
                  progress={progress}
                  targets={runTargets}
                  result={result}
                  scored={scored}
                  error={runError}
                  onStop={stopRun}
                  onStartPreference={() => setStage("preference")}
                  preferenceReady={(result?.targets.length ?? 0) >= 2}
                  registryRunId={registryRunId}
                />
              )
            }
          />
        ) : null}

        {stage === "setup" ? <CompareReports /> : null}

        {stage === "preference" ? (
          <PreferenceStage
            modality={setup.modality}
            state={tournament}
            starting={tournamentStarting}
            error={tournamentError}
            onStart={() =>
              void (isTool ? startToolTournament() : startTournament())
            }
            onVote={castVote}
            onGroupVote={castGroupVote}
            onEliminate={eliminateFromBallot}
            onRank={rankBallot}
            onRevote={revotePrompt}
            onJudge={setup.modality === "image" ? judgeMatch : undefined}
            hint={isTool ? t("compare.tool.pref.condition") : undefined}
            onOptimizeRoute={() => setStage("route")}
          />
        ) : null}

        {stage === "route" ? (
          <RouteStage
            state={tournament}
            onDerive={derivePolicy}
            onBack={() => setStage("preference")}
          />
        ) : null}
      </main>
    </AppShell>
  );
}
