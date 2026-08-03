import type { Example } from '../optimizer/types';
import { cellStatusFromGeneration, emptyMatrix, markCell } from './matrix';
import { buildPreferencePrompt, exampleSections } from './prompt';
import { aggregateFinishReason, summarizePreferenceRun } from './summarize';
import {
  emptyUsage,
  splitUsageFromProvider,
  sumUsage,
} from './usage';
import type {
  CompletionMatrix,
  Generation,
  GenerationLatency,
  GenerationUsage,
  PreferenceRun,
  PreferenceRunSummary,
  SectionGeneration,
} from './types';

export type PreferenceCallerResult = {
  text: string;
  usage: GenerationUsage;
  finishReason: string;
  latency: GenerationLatency;
};

export type PreferenceCaller = (args: {
  modelId: string;
  system: string;
  user: string;
  params: PreferenceRun['generationParams'];
}) => Promise<PreferenceCallerResult>;

export function planPreferenceCells(
  run: Pick<PreferenceRun, 'modelIds' | 'inputIds'>,
): Array<{ modelId: string; inputId: string }> {
  const cells: Array<{ modelId: string; inputId: string }> = [];
  for (const modelId of run.modelIds) {
    for (const inputId of run.inputIds) {
      cells.push({ modelId, inputId });
    }
  }
  return cells;
}

async function generateOneSection(params: {
  caller: PreferenceCaller;
  run: PreferenceRun;
  modelId: string;
  example: Example;
  sectionIndex?: number;
  sectionText?: string;
}): Promise<SectionGeneration> {
  const { system, user } = buildPreferencePrompt({
    task: params.run.task,
    input: params.example,
    sectionIndex: params.sectionIndex,
    sectionText: params.sectionText,
  });
  try {
    const res = await params.caller({
      modelId: params.modelId,
      system,
      user,
      params: params.run.generationParams,
    });
    return {
      sectionIndex: params.sectionIndex ?? 0,
      output: res.text,
      usage: res.usage,
      finishReason: res.finishReason ?? '',
      latency: res.latency,
    };
  } catch (e) {
    return {
      sectionIndex: params.sectionIndex ?? 0,
      output: '',
      usage: emptyUsage(),
      finishReason: '',
      latency: { timeToFirstTokenMs: null, totalMs: 0 },
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Run K×M preference generation. Fail-soft per cell: errors are persisted and the run continues.
 * Generation params are identical for every model (frozen on the run).
 */
export async function runPreferenceGeneration(params: {
  run: PreferenceRun;
  examplesById: Map<string, Example>;
  caller: PreferenceCaller;
  onCell?: (g: Generation, matrix: CompletionMatrix) => void | Promise<void>;
  relativeCostWeightByModel?: Record<string, number>;
}): Promise<{ generations: Generation[]; summary: PreferenceRunSummary; matrix: CompletionMatrix }> {
  const { run, examplesById, caller } = params;
  const matrix = emptyMatrix(run.modelIds, run.inputIds);
  const generations: Generation[] = [];
  const cells = planPreferenceCells(run);
  const n = run.generationParams.parallelSections;

  for (const { modelId, inputId } of cells) {
    const example = examplesById.get(inputId);
    let generation: Generation;

    if (!example) {
      generation = {
        runId: run.id,
        modelId,
        inputId,
        output: '',
        usage: emptyUsage(),
        finishReason: '',
        latency: { timeToFirstTokenMs: null, totalMs: 0 },
        error: `Unknown inputId: ${inputId}`,
      };
    } else if (n > 1) {
      const sectionsDef = exampleSections(example);
      if (!sectionsDef || sectionsDef.length !== n) {
        generation = {
          runId: run.id,
          modelId,
          inputId,
          output: '',
          usage: emptyUsage(),
          finishReason: '',
          latency: { timeToFirstTokenMs: null, totalMs: 0 },
          error: `parallelSections=${n} requires Example.meta.sections with exactly ${n} strings`,
        };
      } else {
        const sections: SectionGeneration[] = [];
        for (let i = 0; i < n; i++) {
          sections.push(
            await generateOneSection({
              caller,
              run,
              modelId,
              example,
              sectionIndex: i,
              sectionText: sectionsDef[i],
            }),
          );
        }
        const sectionError = sections.find((s) => s.error)?.error;
        const usages = sections.map((s) => s.usage);
        const totalMs = Math.max(...sections.map((s) => s.latency.totalMs), 0);
        const ttfts = sections
          .map((s) => s.latency.timeToFirstTokenMs)
          .filter((x): x is number => x != null);
        generation = {
          runId: run.id,
          modelId,
          inputId,
          output: sections.map((s) => s.output).join('\n\n'),
          usage: sumUsage(usages),
          finishReason: aggregateFinishReason(sections),
          latency: {
            timeToFirstTokenMs: ttfts.length ? Math.max(...ttfts) : null,
            totalMs,
          },
          sections,
          error: sectionError,
        };
      }
    } else {
      const section = await generateOneSection({ caller, run, modelId, example });
      generation = {
        runId: run.id,
        modelId,
        inputId,
        output: section.output,
        usage: section.usage,
        finishReason: section.finishReason,
        latency: section.latency,
        error: section.error,
      };
    }

    generations.push(generation);
    markCell(matrix, modelId, inputId, cellStatusFromGeneration(generation));
    await params.onCell?.(generation, matrix);
  }

  const summary = summarizePreferenceRun({
    run,
    generations,
    relativeCostWeightByModel: params.relativeCostWeightByModel,
  });
  return { generations, summary, matrix };
}

/** Map a provider-shaped result into PreferenceCallerResult (for live adapters). */
export function callerResultFromProvider(raw: {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  finishReason?: string;
  latencyMs: number;
  timeToFirstTokenMs?: number;
}): PreferenceCallerResult {
  return {
    text: raw.text,
    usage: splitUsageFromProvider({
      inputTokens: raw.inputTokens,
      cachedInputTokens: raw.cachedInputTokens,
      outputTokens: raw.outputTokens,
      reasoningTokens: raw.reasoningTokens,
    }),
    finishReason: raw.finishReason ?? '',
    latency: {
      timeToFirstTokenMs: raw.timeToFirstTokenMs ?? null,
      totalMs: raw.latencyMs,
    },
  };
}
