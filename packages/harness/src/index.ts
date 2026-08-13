/**
 * @redrob/harness — evolution / routing eval library (pure TypeScript, no DOM).
 */

// Config
export {
  EVAL_DATASETS,
  getDatasetById,
  listDatasets,
  type MetricId,
  type DatasetTask,
  type DatasetRef,
  type HfSource,
} from './config/datasets';
export {
  EVAL_MODELS,
  PROVIDER_LABELS,
  getModelById,
  listSelfHostedModels,
  resolveModelCostWeight,
  modelResultCaveat,
  SELF_HOSTED_CANDIDATES,
  SELF_HOSTED_DEFAULTS,
  SELF_HOSTED_EXCLUSIONS,
  SELF_HOSTED_ENDPOINT_ID,
  SERVED_MODEL_NAME,
  VLLM_ENV,
  baseUrlForServedName,
  buildSelfHostedCaveat,
  relativeCostFromThroughput,
  resolveSelfHostedCostWeight,
  selfHostedSlotId,
  selfHostedSlotRow,
  slotServedName,
  vllmSlotEndpoints,
  type VllmSlotEndpoint,
  type ModelRef,
  type ProviderId,
  type SelfHostedLicense,
  type SelfHostedMeta,
  type SelfHostedPrecision,
  type SelfHostedTier,
} from './config/models';
export {
  applyMeasuredThroughput,
  resetMeasuredThroughputApplied,
} from './config/apply-measured';

// Datasets
export {
  loadDataset,
  previewDatasets,
  HfDatasetError,
} from './lib/datasets';
export type { EvalSample, LoadedDataset } from './lib/datasets/types';

// Metrics
export { scorePair, scorePairs, type ScorePair, type ScoreResult } from './lib/metrics';
export {
  llmJudgeScore,
  buildJudgePrompt,
  parseJudgeResponseForTest,
} from './lib/metrics/llm-judge';
export {
  METRIC_FIXTURES,
  runMetricFixtures,
} from './lib/metrics/fixtures';
export { accuracyMatch, meanAccuracy } from './lib/metrics/accuracy';
export { chrf, meanChrF } from './lib/metrics/chrf';
export {
  extractGsm8kAnswer,
  gsm8kExactMatch,
  meanGsm8kExact,
} from './lib/metrics/gsm8k';
export {
  quadraticWeightedKappa,
  qwkFromPairs,
  qwkPairProxy,
  isAbstention,
  parseOrdinal,
} from './lib/metrics/qwk';
export {
  cohensKappaBinary,
  cohensKappaFromPair,
  parseBinaryLabels,
} from './lib/metrics/cohens-kappa';
export {
  checklistCompositeScore,
  isotonicFit,
  isotonicPredict,
} from './lib/metrics/checklist-composite';
export { abstentionRate, abstentionPairFeedback } from './lib/metrics/abstention';

// Providers
export {
  callModel,
  getProvider,
  listProviders,
  probeVllmEndpoint,
  ProviderError,
} from './lib/providers';
export type { VllmProbeResult, VllmServedModel } from './lib/providers/vllm';
export type {
  CallModelParams,
  CallModelResult,
  ProviderAdapter,
  VisionImagePart,
  VisionTokenControls,
} from './lib/providers/types';

// Catalog
export { resolveEvalModel, resolveEvalModels, resolveModel } from './lib/catalog/resolve';
export type { ResolvedModel } from './lib/catalog/resolve';
export {
  canonicalModelId,
  canonicalIdForRef,
  normalizeModelId,
  parseCanonicalModelId,
  sameModel,
  sourceForProvider,
} from './lib/catalog/model-id';
export type { ModelSource } from './lib/catalog/model-id';
export {
  getOpenRouterCatalog,
  findOpenRouterEntry,
  toPublicModel,
  OR_ID_PREFIX,
  OR_MODALITIES,
  type OrModality,
  type OpenRouterCatalogEntry,
} from './lib/catalog/openrouter';
export {
  getLiveSelfHostedModel,
  getLiveSelfHostedSlots,
  resetLiveSelfHostedCache,
  syncSelfHostedRef,
  type LiveSelfHostedModel,
  type LiveSelfHostedSlot,
} from './lib/catalog/self-hosted-live';
// Router
export { routeSample, classifyComplexity, type RouteDecision } from './lib/router';

// Eval
export {
  runEval,
  CUSTOM_DATASET_ID,
  type CustomPrompt,
  type EvalRunRequest,
} from './lib/eval/run';
export type {
  EvalRunResult,
  EvalStreamEvent,
  EvalTargetSummary,
  EvalSampleResult,
  EvalRunMeta,
} from './lib/eval/types';
export { ROUTER_TARGET_ID } from './lib/eval/types';
export { summarizeTarget, enrichSummaries, pickLargeBaseline, mean } from './lib/eval/aggregate';
export { buildEvalPrompt, maxTokensForTask } from './lib/eval/prompts';
export {
  assertHasCaveat,
  withMandatoryCaveat,
  reportModelTarget,
  ensureResultCaveats,
  INDIC_DATASET_IDS,
  isIndicDataset,
  sliceLabelForDataset,
  type ResultCaveatFields,
  type ReportedTargetSummary,
} from './lib/eval/results';

// Routing data
export type {
  RoutingExample,
  RoutingRunMeta,
  RoutingRunSummary,
  CorpusStats,
  RouteLabel,
  RoutingFeatures,
  ModelCallRecord,
} from './lib/routing-data/types';
export { runRoutingCollection, type RoutingCollectRequest } from './lib/routing-data/collect';
export { extractRoutingFeatures } from './lib/routing-data/features';
export { labelRoute, defaultSmallOkThreshold } from './lib/routing-data/labels';
export {
  labelsFromPreference,
  preferenceRunMeta,
  type PreferenceLabelInput,
  type PreferenceLabelResult,
} from './lib/routing-data/labels-from-preference';
export {
  listRoutingRunIds,
  appendRoutingExamples,
  readRoutingMeta,
  readRoutingExamples,
  readRoutingSummary,
  readCorpusStats,
  computeAndWriteCorpusStats,
  readAllCorpusExamples,
  ensureRoutingDirs,
  writeRoutingMeta,
  writeRoutingSummary,
  appendRoutingExample,
  makeRoutingRunId,
  routingRunDir,
  assertSafeRunId,
  EVAL_ROOT,
  ROUTING_RUNS_DIR,
  ROUTING_CORPUS_DIR,
} from './lib/routing-data/fs';
export { exportTrainJsonl, toChatTrainRow, toFlatTrainRow } from './lib/routing-data/export';
export {
  replayPolicy,
  modelAloneSummary,
  ROUTER_HEURISTIC_ID,
  ROUTER_ORACLE_ID,
  ROUTER_CASCADE_ID,
} from './lib/routing-data/replay';

// Paths
export { getRepoRoot, datasetsDir, evalRoot } from './lib/paths';

// Optimizer (RandomSearch + GEPA)
export type {
  Candidate,
  Demo,
  ModelGene,
  OptimizeContext,
  OptimizeEvent,
  Optimizer,
  EvalBatch,
  Example,
  FrontierPoint,
  ReflectiveRecord,
} from './lib/optimizer/types';
export {
  newCandidateId,
  seedCandidate,
  resolveScriptPolicies,
  resolveFramePolicy,
} from './lib/optimizer/types';
export { RandomSearch } from './lib/optimizer/random-search';
export { Gepa } from './lib/optimizer/gepa/engine';
export {
  makeReflectiveDataset,
  InstanceFrontier,
  sampleMinibatch,
  systemAwareMerge,
  pickMergeParents,
  isFeasible,
  betterFeasible,
  toFrontierPoint,
} from './lib/optimizer/gepa/engine';
export { evaluateCandidate, estimateTokens } from './lib/optimizer/evaluate-candidate';
export { fitDemosToBudget } from './lib/optimizer/fit-demos';
export {
  buildOptimizeReport,
  reportToMarkdown,
  type OptimizeReport,
  type CandidateSnapshot,
} from './lib/optimizer/report';
export {
  applyScriptPolicy,
  defaultScriptBundle,
  SCRIPT_POLICIES,
  type ScriptPolicy,
  type ScriptPolicyBundle,
} from './lib/script-policy';
export {
  defaultFramePolicy,
  fitFramesToBudget,
  sampleFrames,
  sampleUniform,
  sampleMotionEnergy,
  sampleEventDetect,
  tokensPerFrameToPixels,
  parseFramePolicy,
  FRAME_SAMPLE_STRATEGIES,
  FRAME_COUNTS,
  TOKENS_PER_FRAME,
  type FramePolicy,
  type FrameSampleStrategy,
  type FrameBuffer,
  type FitFramesResult,
  type FrameCount,
  type TokensPerFrame,
} from './lib/frame-policy';
export {
  buildCustomGoalSpec,
  parseCustomExamples,
  defaultInstructionFromGoal,
  customGoalToLoadedDataset,
  appendAnchorBlock,
  CUSTOM_GOAL_MIN_EXAMPLES,
  CUSTOM_GOAL_MAX_EXAMPLES,
  type CustomGoalSpec,
  type CustomGoalInput,
  type CustomGoalMode,
  type ReferenceAnchor,
} from './lib/optimizer/custom-goal';
export {
  lintChecklistRubric,
  type RubricLintResult,
  type RubricLintHit,
} from './lib/optimizer/rubric-lint';
export {
  loadVideoLocalManifest,
  videoLocalToLoadedDataset,
  videoLocalDir,
  videoLocalManifestPath,
  VIDEO_LOCAL_DIRNAME,
  type VideoLocalManifest,
  type VideoLocalExample,
  type VideoLocalAnchor,
} from './lib/datasets/video-local';
export {
  parseFrameSetInput,
  loadFrameImages,
  frameBuffersFromPaths,
} from './lib/vision/frames';
export {
  buildPairwiseVisionContent,
  splitVisionContent,
  imagePartToContent,
  type VisionContentPart,
} from './lib/vision/pairwise';

// Splits
export type { SplitName, SplitBundle } from './lib/splits/types';
export { assertSplitIsolation, splitExamples } from './lib/splits';

// Reporting guards — absolute currency must never reach UI or exports
export { containsCurrency } from './lib/reporting/no-currency';

// Experiment registry: the one record every kind of run shares
export {
  createRunStore,
  defaultRegistryPath,
  registryConfigFromEnv,
  FsRunStore,
  SqliteRunStore,
  applyFilter,
  matchesFilter,
  captureProvenance,
  hashParams,
  makeRunId,
  isTerminal,
} from './lib/registry';
export type {
  Json as RunJson,
  NewRun,
  NewRunEvent,
  Provenance,
  RegistryConfig,
  RegistryDriver,
  RunEvent,
  RunFilter,
  RunPatch,
  RunRecord,
  RunStatus,
  RunStore,
} from './lib/registry';

// Resumable job queue: run a matrix of cells under a concurrency budget
export { expandMatrix, runMatrix, MemoryCheckpoint, runStoreCheckpoint } from './lib/queue';
export type {
  Cell as QueueCell,
  CellOutcome,
  CellStatus as QueueCellStatus,
  Checkpoint,
  MatrixResult,
  QueueProgress,
  RunMatrixParams,
} from './lib/queue';

// Blind World Cup preference tournament
export {
  activeContenders,
  advance,
  advanceGroup,
  aggregateTournament,
  appendVote,
  appendVotes,
  appendVoteUndo,
  assertSafeTournamentRunId,
  bracketIsSettled,
  championOf,
  createBracket,
  eliminateFromGroup,
  foldVoteLog,
  groupIsPending,
  isVoteUndo,
  listTournaments,
  makeTournamentRunId,
  nextPendingMatch,
  rankBracket,
  rankGroup,
  readTournament,
  resolvedMatches,
  totalMatches,
  writeTournament,
  writeTournamentMeta,
  GROUP_VOTE_MAX,
} from './lib/tournament';
export type {
  Bracket,
  Competitor,
  GroupMatch,
  Match,
  ModelStanding,
  TournamentAggregate,
  TournamentMeta,
  TournamentRun,
  Vote,
  VoteLogEntry,
  VoteUndo,
  VoteWinner,
} from './lib/tournament';

// Preference generation (Stage 1 — task-grounded outputs for later blind voting)
export type {
  CellStatus,
  CompletionMatrix,
  Generation,
  GenerationUsage,
  ModelRunStats,
  PreferenceGenerationParams,
  PreferenceProgressEvent,
  PreferenceRun,
  PreferenceRunSummary,
  SectionGeneration,
} from './lib/preference';
export {
  DEFAULT_PREFERENCE_GENERATION_PARAMS,
  assertIdenticalGenerationParams,
  promptFingerprint,
  taskIdFromSpecParts,
  buildPreferencePrompt,
  preferencePromptFingerprint,
  exampleSections,
  splitUsageFromProvider,
  emptyUsage,
  sumUsage,
  isLengthTruncation,
  truncationRate,
  sectionLengthStats,
  emptyMatrix,
  cellStatusFromGeneration,
  markCell,
  matrixFromGenerations,
  summarizePreferenceRun,
  planPreferenceCells,
  runPreferenceGeneration,
  callerResultFromProvider,
  assertSafePreferenceRunId,
  makePreferenceRunId,
  readPreferenceMeta,
  readPreferenceGenerations,
  readPreferenceSummary,
  readPreferenceEvents,
  listPreferenceRunIds,
  startPreferenceJob,
  abortPreferenceJob,
  getActivePreferenceJob,
  type PreferenceCaller,
  type PreferenceJobRequest,
} from './lib/preference';

// Jobs / manifest
export type { RunManifest } from './lib/jobs/manifest';
export {
  writeRunManifest,
  readRunManifest,
  appendProgressEvent,
  readProgressEvents,
  writeJobStatus,
} from './lib/jobs/fs';
export { startRoutingCollectJob, abortJob, getActiveJob } from './lib/jobs/runner';
export { buildRunManifest, tryGitSha } from './lib/jobs/manifest-helpers';
export {
  startOptimizeJob,
  abortOptimizeJob,
  getActiveOptimizeJob,
  type OptimizeJobRequest,
} from './lib/jobs/optimize-runner';
export {
  assertSafeOptimizeRunId,
  makeOptimizeRunId,
  readOptimizeMeta,
  readOptimizeEvents,
  readOptimizeResult,
  readOptimizeReport,
  readOptimizeReportMarkdown,
  listOptimizeRunIds,
  writeOptimizeMeta,
  type OptimizeRunMeta,
} from './lib/jobs/optimize-fs';

// Fixed-toolset SLM routing harness (separate from small/large routing-data)
export {
  FERTILITY_BASELINE_ID,
  TOOL_ROUTING_MODELS,
  TOOL_ROUTING_DEFAULT_LANGUAGES,
  TOOL_ROUTING_LANGUAGES,
  TOOL_ROUTING_CONDITIONS,
  TOOL_ROUTING_COMPARE_CONDITIONS,
  TOOLSETS,
  getToolRoutingModel,
  listDefaultToolRoutingModels,
  listToolRoutingModels,
  THINKING_OFF_EXTRA_BODY,
  buildToolRoutingPrompt,
  toolRoutingBallotText,
  parseToolRoutingPrediction,
  stripReasoning,
  argsExactEqual,
  scoreToolRoutingExample,
  aggregateSlice,
  buildConditionDeltas,
  buildToolRoutingReport,
  measureToolRoutingFertility,
  normalizeToolRoutingLanguages,
  formatFertilityMarkdown,
  runToolRoutingHarness,
  validateToolRoutingTasks,
  verbatimArgNames,
  loadStubFertilityCorpus,
  loadStubToolRoutingTasks,
  loadStubToolsets,
  type ToolRoutingModel,
  type ToolRoutingTask,
  type ToolRoutingReport,
  type ToolRoutingCondition,
  type ToolRoutingLanguage,
  type ToolRoutingExampleRecord,
  type ToolsetId,
  type FertilityCell,
  type TaskProblem,
} from './lib/tool-routing';

// Multi-turn: the same models, asked to hold a conversation together
export {
  buildMultiTurnReport,
  buildSystemPrompt as buildMultiTurnSystemPrompt,
  calledTool,
  formatToolResult,
  loadMultiTurnScenarios,
  multiTurnScenariosFor,
  runCheck,
  runChecks,
  runMultiTurnHarness,
  runScenario,
  MULTI_TURN_MAX_TOKENS,
} from './lib/multi-turn';
export type {
  CapabilitySlice,
  DepthSlice,
  LoadedScenario,
  MultiTurnCaller,
  MultiTurnCapability,
  MultiTurnLanguage,
  MultiTurnReport,
  MultiTurnScenario,
  ScenarioRecord,
  ScriptedTurn,
  TurnCheck,
  TurnCheckResult,
  TurnRecord,
} from './lib/multi-turn';
