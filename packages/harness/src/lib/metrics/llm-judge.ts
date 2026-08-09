/**
 * LLM-as-judge metric for custom GEPA goals.
 * Returns score in [0,1] plus diagnostic feedback for reflection.
 */
import type { ProviderId } from '../../config/models';
import { callModel, ProviderError } from '../providers';

export interface LlmJudgeParams {
  goal: string;
  rubric: string;
  input: string;
  prediction: string;
  judge: { providerId: ProviderId; modelId: string };
}

export interface LlmJudgeResult {
  score: number;
  feedback: string;
  /**
   * Per-dimension scores in [0,1], keyed by the name the rubric used.
   *
   * Absent when the rubric names no dimensions, or the judge declined to break its
   * verdict down. A rubric listing "Readability (1-10)" and "Accuracy (1-10)" is
   * otherwise collapsed into one number, and the reader cannot see that accuracy is
   * fine while calibration is dragging — which is the only part they can act on.
   */
  dimensions?: Record<string, number>;
  raw?: string;
}

/** The scale rubric dimensions are assumed to use when they say "1-10". */
export const DIMENSION_MAX = 10;

/**
 * The dimension names a rubric declares, in the order it declares them.
 *
 * Recognises the shape people actually write — a bulleted or numbered line whose label
 * is followed by a range in brackets — rather than asking them to restate the rubric in
 * a second, structured field. A rubric it does not recognise yields no dimensions and
 * behaves exactly as before: one score, one paragraph.
 */
export function rubricDimensions(rubric: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const line of rubric.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:[-*•]|\d+[.)])\s*([^:(\[]{2,60}?)\s*[([]\s*\d+\s*(?:-|–|to)\s*\d+\s*[)\]]/i,
    );
    const name = match?.[1]?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    if (names.length >= 12) break;
  }
  return names;
}

/** Read the `dimensions` object, keeping only what the rubric asked for. */
function parseDimensions(
  raw: unknown,
  wanted: string[],
  max: number,
): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const byLower = new Map(wanted.map((w) => [w.toLowerCase(), w]));
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    // A judge inventing a criterion is a judge scoring something the reader did not
    // choose, and it would sit in the breakdown as though they had.
    const name = byLower.get(key.trim().toLowerCase());
    if (!name) continue;
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) continue;
    // Normalised once, here. The rubric speaks in 1-10 because that is how people think;
    // everything downstream of this is a fraction.
    out[name] = Math.min(1, Math.max(0, n / max));
  }
  return Object.keys(out).length ? out : undefined;
}

function parseJudgeJson(
  text: string,
  dimensionNames: string[] = [],
  dimensionMax = DIMENSION_MAX,
): { score: number; feedback: string; dimensions?: Record<string, number> } | null {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1]!.trim() : trimmed;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
    const dimensions = parseDimensions(obj.dimensions, dimensionNames, dimensionMax);

    const scoreRaw = obj.score;
    let score =
      typeof scoreRaw === 'number'
        ? scoreRaw
        : typeof scoreRaw === 'string'
          ? Number(scoreRaw)
          : NaN;
    // A judge that broke its verdict down and then forgot the overall number has already
    // said everything needed: the mean of the parts is the whole, by the rubric's own
    // instruction to average them.
    if (!Number.isFinite(score) && dimensions) {
      const values = Object.values(dimensions);
      score = values.reduce((a, b) => a + b, 0) / values.length;
    }
    if (!Number.isFinite(score)) return null;

    const feedback =
      typeof obj.feedback === 'string' && obj.feedback.trim()
        ? obj.feedback.trim()
        : 'Judge returned no feedback.';
    return {
      score: Math.min(1, Math.max(0, score)),
      feedback,
      dimensions,
    };
  } catch {
    return null;
  }
}

export function buildJudgePrompt(params: {
  goal: string;
  rubric: string;
  input: string;
  prediction: string;
  /** Dimension names to break the verdict down by; omit for a single score. */
  dimensions?: string[];
}): string {
  const dims = params.dimensions ?? [];
  const shape = dims.length
    ? `{"dimensions":{${dims
        .map((d) => `"${d}":<number 1 to ${DIMENSION_MAX}>`)
        .join(',')}},"score":<number 0 to 1>,"feedback":"<one short diagnostic paragraph>"}`
    : '{"score":<number 0 to 1>,"feedback":"<one short diagnostic paragraph>"}';

  return [
    'You are scoring a model output against a fixed goal and rubric.',
    `Return ONLY a JSON object: ${shape}.`,
    ...(dims.length
      ? [
          `Score every dimension listed, each from 1 to ${DIMENSION_MAX}, using the rubric's own definition of it.`,
          'Then set "score" to the overall verdict in 0 to 1, applying any caps or weights the rubric states.',
        ]
      : []),
    'score=1 means fully meets the rubric; score=0 means fails completely.',
    'Do NOT mention absolute prices or dollar costs.',
    '',
    '## Goal',
    params.goal,
    '',
    '## Rubric',
    params.rubric,
    '',
    '## Input',
    params.input,
    '',
    '## Model output',
    params.prediction || '(empty)',
  ].join('\n');
}

export async function llmJudgeScore(params: LlmJudgeParams): Promise<LlmJudgeResult> {
  if (!params.prediction.trim()) {
    return {
      score: 0,
      feedback: 'Empty model output; fails the rubric.',
    };
  }

  const dimensions = rubricDimensions(params.rubric);

  try {
    const result = await callModel(
      params.judge.providerId,
      params.judge.modelId,
      buildJudgePrompt({
        goal: params.goal,
        rubric: params.rubric,
        input: params.input,
        prediction: params.prediction,
        dimensions,
      }),
      // Room for the breakdown as well as the paragraph. Judge replies are short, so
      // this is headroom rather than spend.
      { maxTokens: dimensions.length ? 700 : 400, temperature: 0 },
    );
    const parsed = parseJudgeJson(result.text, dimensions);
    if (!parsed) {
      return {
        score: 0,
        feedback: `Judge reply was not valid JSON; treated as score 0. Raw starts: "${result.text.slice(0, 120)}"`,
        raw: result.text,
      };
    }
    return { ...parsed, raw: result.text };
  } catch (e) {
    const message =
      e instanceof ProviderError
        ? e.message
        : e instanceof Error
          ? e.message
          : 'Judge call failed';
    return {
      score: 0,
      feedback: `Judge error: ${message}`,
    };
  }
}

/** Offline helper for verify scripts. */
export function parseJudgeResponseForTest(
  text: string,
  dimensionNames: string[] = [],
): LlmJudgeResult {
  const parsed = parseJudgeJson(text, dimensionNames);
  if (!parsed) {
    return {
      score: 0,
      feedback: 'Judge reply was not valid JSON; treated as score 0.',
      raw: text,
    };
  }
  return parsed;
}
