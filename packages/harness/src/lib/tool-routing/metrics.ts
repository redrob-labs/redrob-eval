import { argsExactEqual } from './parse';
import type {
  ExpectedOutcome,
  ParsedPrediction,
  ToolRoutingConditionSlice,
  ToolRoutingExampleScore,
  ToolRoutingLanguage,
  ToolRoutingCondition,
} from './types';

export function scoreToolRoutingExample(params: {
  expected: ExpectedOutcome;
  prediction: ParsedPrediction;
  latencyGpuMs: number | null;
}): ToolRoutingExampleScore {
  const { expected, prediction, latencyGpuMs } = params;

  if (prediction.kind === 'parse_error') {
    // Deliberately still a parse failure: the contract asked for one shape and
    // got another. The extra fields only say which kind of failure it was.
    const envelope = prediction.envelope;
    return {
      toolSelectCorrect: null,
      argExactMatch: null,
      absenceCorrect: null,
      parseFailed: true,
      envelopeError: envelope != null,
      envelopeToolWouldMatch:
        envelope == null || expected.kind !== 'call' ? null : envelope.tool === expected.tool,
      latencyGpuMs,
      latencyCpuMs: null,
    };
  }

  if (expected.kind === 'absence') {
    const absenceCorrect =
      prediction.kind === 'absence' && prediction.action === expected.action;
    return {
      toolSelectCorrect: null,
      argExactMatch: null,
      absenceCorrect,
      parseFailed: false,
      latencyGpuMs,
      latencyCpuMs: null,
    };
  }

  // expected call
  if (prediction.kind === 'absence') {
    return {
      toolSelectCorrect: false,
      argExactMatch: false,
      absenceCorrect: null,
      parseFailed: false,
      latencyGpuMs,
      latencyCpuMs: null,
    };
  }

  const toolSelectCorrect = prediction.tool === expected.tool;
  const argExactMatch =
    toolSelectCorrect && argsExactEqual(prediction.arguments, expected.arguments);

  return {
    toolSelectCorrect,
    argExactMatch,
    absenceCorrect: null,
    parseFailed: false,
    latencyGpuMs,
    latencyCpuMs: null,
  };
}

function rate(hits: number, total: number): number | null {
  return total === 0 ? null : hits / total;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export function aggregateSlice(params: {
  condition: ToolRoutingCondition;
  language: ToolRoutingLanguage;
  scores: ToolRoutingExampleScore[];
}): ToolRoutingConditionSlice {
  const { condition, language, scores } = params;
  let toolHits = 0;
  let toolN = 0;
  let argHits = 0;
  let argN = 0;
  let absenceHits = 0;
  let absenceN = 0;
  let parseFails = 0;
  let envelopeErrors = 0;
  let envelopeToolWouldMatch = 0;
  const gpu: number[] = [];

  for (const s of scores) {
    if (s.parseFailed) parseFails += 1;
    if (s.envelopeError) {
      envelopeErrors += 1;
      if (s.envelopeToolWouldMatch) envelopeToolWouldMatch += 1;
    }
    if (s.toolSelectCorrect != null) {
      toolN += 1;
      if (s.toolSelectCorrect) toolHits += 1;
    }
    if (s.argExactMatch != null) {
      argN += 1;
      if (s.argExactMatch) argHits += 1;
    }
    if (s.absenceCorrect != null) {
      absenceN += 1;
      if (s.absenceCorrect) absenceHits += 1;
    }
    if (s.latencyGpuMs != null) gpu.push(s.latencyGpuMs);
  }

  gpu.sort((a, b) => a - b);

  return {
    condition,
    language,
    n: scores.length,
    toolSelectAccuracy: rate(toolHits, toolN),
    argExactMatchAccuracy: rate(argHits, argN),
    absenceAccuracy: rate(absenceHits, absenceN),
    parseFailureRate: scores.length === 0 ? 0 : parseFails / scores.length,
    denominators: { toolSelect: toolN, argExactMatch: argN, absence: absenceN },
    envelope: { errors: envelopeErrors, toolWouldMatch: envelopeToolWouldMatch },
    latencyGpuMs: { p50: percentile(gpu, 50), p95: percentile(gpu, 95) },
    latencyCpuMs: { p50: null, p95: null },
  };
}

export function delta(
  a: number | null,
  b: number | null,
): number | null {
  if (a == null || b == null) return null;
  return a - b;
}
