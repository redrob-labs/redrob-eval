import type { RoutingExample, RoutingTrainChatRow, RoutingTrainFlatRow } from './types';

const SYSTEM = `You are a routing model. Given a user task, choose which model tier should answer: "small" (cheap) or "large" (capable). Reply with exactly one word: small or large.`;

export function toChatTrainRow(ex: RoutingExample): RoutingTrainChatRow {
  const feat = ex.features;
  const user = [
    `Task: ${ex.task}`,
    `Dataset: ${ex.datasetId}`,
    `Chars: ${feat.charLen}; words: ${feat.wordCount}; digits: ${feat.digitCount}`,
    `Heuristic: ${feat.heuristicComplexity} (${feat.heuristicScore.toFixed(2)}): ${feat.heuristicReasons.join(', ')}`,
    '',
    'Query:',
    ex.input,
  ].join('\n');

  return {
    id: ex.id,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user },
      { role: 'assistant', content: ex.label },
    ],
    meta: {
      datasetId: ex.datasetId,
      task: ex.task,
      label: ex.label,
      runId: ex.runId,
      sampleId: ex.sampleId,
    },
  };
}

export function toFlatTrainRow(ex: RoutingExample): RoutingTrainFlatRow {
  return {
    id: ex.id,
    input: ex.input,
    label: ex.label,
    task: ex.task,
    datasetId: ex.datasetId,
    features: ex.features,
    runId: ex.runId,
    sampleId: ex.sampleId,
    smallScore: ex.small.score,
    largeScore: ex.large.score,
    smallModelId: ex.small.modelId,
    largeModelId: ex.large.modelId,
  };
}

export function exportTrainJsonl(
  examples: RoutingExample[],
  format: 'chat' | 'flat',
): string {
  const lines =
    format === 'chat'
      ? examples.map((ex) => JSON.stringify(toChatTrainRow(ex)))
      : examples.map((ex) => JSON.stringify(toFlatTrainRow(ex)));
  return lines.join('\n') + (lines.length ? '\n' : '');
}
