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
  raw?: string;
}

function parseJudgeJson(text: string): { score: number; feedback: string } | null {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1]!.trim() : trimmed;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
    const scoreRaw = obj.score;
    const score =
      typeof scoreRaw === 'number'
        ? scoreRaw
        : typeof scoreRaw === 'string'
          ? Number(scoreRaw)
          : NaN;
    if (!Number.isFinite(score)) return null;
    const feedback =
      typeof obj.feedback === 'string' && obj.feedback.trim()
        ? obj.feedback.trim()
        : 'Judge returned no feedback.';
    return {
      score: Math.min(1, Math.max(0, score)),
      feedback,
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
}): string {
  return [
    'You are scoring a model output against a fixed goal and rubric.',
    'Return ONLY a JSON object: {"score":<number 0 to 1>,"feedback":"<one short diagnostic paragraph>"}.',
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

  try {
    const result = await callModel(
      params.judge.providerId,
      params.judge.modelId,
      buildJudgePrompt({
        goal: params.goal,
        rubric: params.rubric,
        input: params.input,
        prediction: params.prediction,
      }),
      { maxTokens: 400, temperature: 0 },
    );
    const parsed = parseJudgeJson(result.text);
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
export function parseJudgeResponseForTest(text: string): LlmJudgeResult {
  const parsed = parseJudgeJson(text);
  if (!parsed) {
    return {
      score: 0,
      feedback: 'Judge reply was not valid JSON; treated as score 0.',
      raw: text,
    };
  }
  return parsed;
}
