import { countTokens, wordCount } from '@redrob/tokenizers';

import {
  FERTILITY_BASELINE_ID,
  getToolRoutingModel,
  listToolRoutingModels,
  type ToolRoutingModel,
} from './models';
import type { FertilityCell, ToolRoutingLanguage } from './types';
import { TOOL_ROUTING_LANGUAGES } from './types';

export type FertilityCorpus = Record<ToolRoutingLanguage, string>;

export type ToolRoutingProgressEvent = {
  done: number;
  total: number;
  message: string;
};

/** Must throw rather than estimate when the tokenizer cannot be loaded. */
export type TokenCounter = (
  hfRepoId: string,
  text: string,
) => Promise<{ tokens: number; tokenizerId: string }>;

/**
 * Measure tokens-per-word for each model × language.
 * Relative column is vs Qwen3-0.6B on the same language (baseline = 1.0).
 * Inference is never invoked - tokenizer load only.
 */
export async function measureToolRoutingFertility(params: {
  corpus: FertilityCorpus;
  models?: ToolRoutingModel[];
  languages?: ToolRoutingLanguage[];
  includeEvalOnly?: boolean;
  onProgress?: (event: ToolRoutingProgressEvent) => void;
  /** Fired after each cell is measured (before relative baseline fill). */
  onCell?: (cell: FertilityCell) => void;
  /** Injectable for tests; defaults to the real Hugging Face tokenizer. */
  countTokensImpl?: TokenCounter;
}): Promise<FertilityCell[]> {
  const count = params.countTokensImpl ?? countTokens;
  const models = params.models ?? listToolRoutingModels({ includeEvalOnly: params.includeEvalOnly });
  const languages = params.languages ?? TOOL_ROUTING_LANGUAGES;
  const cells: FertilityCell[] = [];
  const total = models.length * languages.length;
  let done = 0;

  for (const model of models) {
    for (const language of languages) {
      const text = params.corpus[language];
      params.onProgress?.({
        done,
        total,
        message: `${model.id} / ${language}`,
      });
      let cell: FertilityCell;
      // countTokens rather than measureFertility: the latter falls back to a
      // character heuristic, and an estimate that looks like a measurement is
      // worse here than an empty cell.
      try {
        const words = wordCount(text);
        const r = await count(model.hfRepoId, text);
        cell = {
          modelId: model.id,
          hfRepoId: model.hfRepoId,
          language,
          tokens: r.tokens,
          words,
          fertility: words > 0 ? r.tokens / words : 0,
          relativeToBaseline: null,
          tokenizerId: r.tokenizerId,
          measured: true,
        };
      } catch (error) {
        cell = {
          modelId: model.id,
          hfRepoId: model.hfRepoId,
          language,
          tokens: 0,
          words: 0,
          fertility: 0,
          relativeToBaseline: null,
          tokenizerId: model.hfRepoId,
          measured: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      cells.push(cell);
      done += 1;
      params.onCell?.(cell);
      params.onProgress?.({
        done,
        total,
        message: `${model.id} / ${language}`,
      });
    }
  }

  const baseline = getToolRoutingModel(FERTILITY_BASELINE_ID);
  if (!baseline) return cells;

  const baseByLang = new Map<ToolRoutingLanguage, number>();
  for (const c of cells) {
    if (c.modelId === FERTILITY_BASELINE_ID && c.measured && c.fertility > 0) {
      baseByLang.set(c.language, c.fertility);
    }
  }

  for (const c of cells) {
    const base = baseByLang.get(c.language);
    if (base && c.measured && c.fertility > 0) {
      c.relativeToBaseline = c.fertility / base;
    }
  }

  return cells;
}

/** Render a compact markdown table for the fertility report. */
export function formatFertilityMarkdown(cells: FertilityCell[]): string {
  const lines = [
    '| model | language | fertility | relative (Qwen3-0.6B=1.0) | notes |',
    '| --- | --- | ---: | ---: | --- |',
  ];
  for (const c of cells) {
    const fert = c.measured ? c.fertility.toFixed(3) : 'unmeasured';
    const rel =
      c.relativeToBaseline == null ? '-' : c.relativeToBaseline.toFixed(3);
    lines.push(
      `| ${c.modelId} | ${c.language} | ${fert} | ${rel} | ${c.error ?? ''} |`,
    );
  }
  return lines.join('\n');
}
