import type { DatasetTask } from '../../config/datasets';
import { classifyComplexity } from '../router/index';
import type { RoutingFeatures } from './types';

/** Extract routing features from input only — never from gold or model outputs. */
export function extractRoutingFeatures(params: {
  input: string;
  task: DatasetTask;
  datasetId: string;
}): RoutingFeatures {
  const text = params.input.trim();
  const words = text.split(/\s+/).filter(Boolean);
  const digits = text.match(/\d/g) ?? [];
  const sentences = text.split(/[.!?。！？]+/).filter((s) => s.trim().length > 0);
  const heuristic = classifyComplexity(text, params.task);
  const avgWordLen =
    words.length === 0
      ? 0
      : words.reduce((a, w) => a + w.length, 0) / words.length;

  return {
    charLen: text.length,
    wordCount: words.length,
    digitCount: digits.length,
    sentenceCount: Math.max(1, sentences.length),
    questionMarkCount: (text.match(/\?/g) ?? []).length,
    newlineCount: (text.match(/\n/g) ?? []).length,
    avgWordLen: Math.round(avgWordLen * 100) / 100,
    heuristicScore: heuristic.score,
    heuristicComplexity: heuristic.complexity,
    heuristicReasons: heuristic.reasons,
    task: params.task,
    datasetId: params.datasetId,
  };
}
