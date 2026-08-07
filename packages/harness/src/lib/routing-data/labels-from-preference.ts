import type { Bracket, Vote } from '../tournament/types';
import { extractRoutingFeatures } from './features';
import { classifyComplexity } from '../router/index';
import type {
  ModelCallRecord,
  RouteLabel,
  RoutingExample,
  RoutingRunMeta,
} from './types';

/**
 * Routing labels derived from human preference instead of a metric.
 *
 * `labels.ts` asks "did the small model clear a score threshold". Here there is
 * no score to threshold: the user designates a fast candidate, and for each
 * prompt the label is `small` when that candidate beat or tied the prompt's
 * bracket champion. Same `RoutingExample` shape, so the corpus, replay and
 * export paths are untouched.
 */

export interface PreferenceLabelInput {
  brackets: Bracket[];
  votes: Vote[];
  /** Canonical id of the fast model the router would prefer. */
  smallModelId: string;
  /** Canonical id of the fallback the router escalates to. */
  largeModelId: string;
  smallModelLabel?: string;
  largeModelLabel?: string;
  runId: string;
  sourceRunId: string;
  seed?: number;
}

export interface PreferenceLabelResult {
  examples: RoutingExample[];
  /** Fraction of prompts the fast model can carry. */
  saveRate: number;
  /** Prompts where neither designated model competed. */
  skipped: number;
}

/** Did `modelId` beat or tie `opponentId` anywhere in this bracket? */
function heldItsOwn(
  votes: Vote[],
  promptId: string,
  modelId: string,
  opponentId: string,
): boolean | null {
  const head = votes.filter(
    (v) =>
      v.promptId === promptId &&
      ((v.aModelId === modelId && v.bModelId === opponentId) ||
        (v.bModelId === modelId && v.aModelId === opponentId)),
  );
  if (!head.length) return null;
  return head.every((v) => v.winner === 'tie' || v.winnerModelId === modelId);
}

function callRecord(params: {
  modelId: string;
  label: string;
  answer: string;
  won: boolean;
  error?: string;
}): ModelCallRecord {
  return {
    modelId: params.modelId,
    modelLabel: params.label,
    // Preference labeling never sees pricing, so cost weight stays neutral.
    relativeCostWeight: 1,
    prediction: params.answer,
    score: params.error ? 0 : params.won ? 1 : 0,
    feedback: params.error
      ? `errored: ${params.error}`
      : params.won
        ? 'preferred by the voter'
        : 'not preferred by the voter',
    latencyMs: 0,
    error: params.error,
  };
}

export function labelsFromPreference(
  input: PreferenceLabelInput,
): PreferenceLabelResult {
  const { brackets, votes, smallModelId, largeModelId } = input;
  const createdAt = new Date().toISOString();
  const seed = input.seed ?? 0;

  const examples: RoutingExample[] = [];
  let skipped = 0;

  for (const bracket of brackets) {
    const small = bracket.competitors.find((c) => c.modelId === smallModelId);
    const large = bracket.competitors.find((c) => c.modelId === largeModelId);
    if (!small || !large) {
      skipped += 1;
      continue;
    }

    const champion = bracket.championModelId;
    let label: RouteLabel;
    let labelReason: string;

    if (small.error) {
      label = 'large';
      labelReason = `fast model errored: ${small.error}`;
    } else if (champion === smallModelId) {
      label = 'small';
      labelReason = 'fast model won this prompt outright';
    } else {
      const direct = heldItsOwn(votes, bracket.promptId, smallModelId, largeModelId);
      if (direct === true) {
        label = 'small';
        labelReason = 'fast model beat or tied the fallback head to head';
      } else if (direct === false) {
        label = 'large';
        labelReason = 'fallback beat the fast model head to head';
      } else if (champion == null) {
        label = 'large';
        labelReason = 'bracket unresolved; escalate by default';
      } else {
        label = 'large';
        labelReason = `another model won this prompt (${champion})`;
      }
    }

    const smallWon = label === 'small';
    examples.push({
      id: `${input.runId}:${bracket.promptId}`,
      runId: input.runId,
      createdAt,
      sampleId: bracket.promptId,
      datasetId: input.sourceRunId,
      datasetLabel: `preference ${input.sourceRunId}`,
      task: 'custom',
      metric: 'llm_judge',
      seed,
      input: bracket.promptText,
      // Human preference has no reference answer; the vote is the supervision.
      gold: '',
      small: callRecord({
        modelId: smallModelId,
        label: small.label,
        answer: small.answer,
        won: smallWon,
        error: small.error,
      }),
      large: callRecord({
        modelId: largeModelId,
        label: large.label,
        answer: large.answer,
        won: !smallWon,
        error: large.error,
      }),
      label,
      labelReason,
      // Not a score threshold here — preference is binary.
      smallOkThreshold: 1,
      features: extractRoutingFeatures({
        input: bracket.promptText,
        task: 'custom',
        datasetId: input.sourceRunId,
      }),
      heuristic: (() => {
        const c = classifyComplexity(bracket.promptText, 'custom');
        const tier = c.complexity === 'easy' ? 'small' : 'large';
        return {
          sampleId: bracket.promptId,
          complexity: c.complexity,
          complexityScore: c.score,
          reasons: c.reasons,
          chosenTier: tier,
          chosenModelId: tier === 'small' ? smallModelId : largeModelId,
          chosenModelLabel: tier === 'small' ? small.label : large.label,
        };
      })(),
    });
  }

  const labeledSmall = examples.filter((e) => e.label === 'small').length;
  return {
    examples,
    saveRate: examples.length ? labeledSmall / examples.length : 0,
    skipped,
  };
}

export function preferenceRunMeta(params: {
  runId: string;
  sourceRunId: string;
  smallModelId: string;
  largeModelId: string;
  smallModelLabel: string;
  largeModelLabel: string;
  examples: RoutingExample[];
  seed?: number;
}): RoutingRunMeta {
  const labelSmall = params.examples.filter((e) => e.label === 'small').length;
  const now = new Date().toISOString();
  return {
    runId: params.runId,
    createdAt: now,
    finishedAt: now,
    status: 'ready',
    datasetId: params.sourceRunId,
    datasetLabel: `preference ${params.sourceRunId}`,
    task: 'custom',
    metric: 'llm_judge',
    sampleCount: params.examples.length,
    seed: params.seed ?? 0,
    smallModelId: params.smallModelId,
    largeModelId: params.largeModelId,
    smallModelLabel: params.smallModelLabel,
    largeModelLabel: params.largeModelLabel,
    smallOkThreshold: 1,
    labeled: params.examples.length,
    labelSmall,
    labelLarge: params.examples.length - labelSmall,
  };
}
