/**
 * Candidate SLMs for the fixed-toolset routing harness.
 *
 * Separate from EVAL_MODELS: these are research candidates for a tool-routing
 * SLM, not the Compare/Evolve catalog. `usable: 'eval_only'` models are never
 * in the default run set - they need an explicit flag.
 */

export type ToolRoutingUsable = true | 'eval_only';

export type ToolRoutingLicense =
  | 'apache-2.0'
  | 'mit'
  | 'cc-by-nc-4.0'
  /** LFM Open License v1.0: commercial grant lapses at $10M annual revenue. */
  | 'lfm1.0';

export interface ToolRoutingModel {
  /** Stable id used in reports */
  id: string;
  /** Hugging Face repo id (also the tokenizer id) */
  hfRepoId: string;
  label: string;
  license: ToolRoutingLicense;
  usable: ToolRoutingUsable;
  /** Hybrid SSM variants - may fail to load on some runtimes; record skip, do not abort. */
  hybridSsm?: boolean;
  notes?: string;
}

/**
 * Fertility baseline for relative tokens-per-word (always 1.0 in the table).
 */
export const FERTILITY_BASELINE_ID = 'qwen3-0.6b';

export const TOOL_ROUTING_MODELS: ToolRoutingModel[] = [
  {
    id: 'qwen3-0.6b',
    hfRepoId: 'Qwen/Qwen3-0.6B',
    label: 'Qwen3 0.6B',
    license: 'apache-2.0',
    usable: true,
  },
  {
    id: 'qwen3-1.7b',
    hfRepoId: 'Qwen/Qwen3-1.7B',
    label: 'Qwen3 1.7B',
    license: 'apache-2.0',
    usable: true,
  },
  {
    id: 'qwen3-4b',
    hfRepoId: 'Qwen/Qwen3-4B',
    label: 'Qwen3 4B',
    license: 'apache-2.0',
    usable: true,
  },
  {
    id: 'qwen35-0.8b',
    hfRepoId: 'Qwen/Qwen3.5-0.8B',
    label: 'Qwen3.5 0.8B',
    license: 'apache-2.0',
    usable: true,
  },
  {
    id: 'qwen35-2b',
    hfRepoId: 'Qwen/Qwen3.5-2B',
    label: 'Qwen3.5 2B',
    license: 'apache-2.0',
    usable: true,
  },
  {
    id: 'qwen35-4b',
    hfRepoId: 'Qwen/Qwen3.5-4B',
    label: 'Qwen3.5 4B',
    license: 'apache-2.0',
    usable: true,
  },
  {
    id: 'granite-4.0-1b',
    hfRepoId: 'ibm-granite/granite-4.0-1b',
    label: 'Granite 4.0 1B',
    license: 'apache-2.0',
    usable: true,
  },
  {
    id: 'granite-4.0-350m',
    hfRepoId: 'ibm-granite/granite-4.0-350m',
    label: 'Granite 4.0 350M',
    license: 'apache-2.0',
    usable: true,
  },
  {
    id: 'granite-4.0-h-1b',
    hfRepoId: 'ibm-granite/granite-4.0-h-1b',
    label: 'Granite 4.0 H 1B',
    license: 'apache-2.0',
    usable: true,
    hybridSsm: true,
    notes: 'Hybrid SSM - skip if the serving stack cannot load it.',
  },
  {
    id: 'granite-4.0-h-350m',
    hfRepoId: 'ibm-granite/granite-4.0-h-350m',
    label: 'Granite 4.0 H 350M',
    license: 'apache-2.0',
    usable: true,
    hybridSsm: true,
    notes: 'Hybrid SSM - skip if the serving stack cannot load it.',
  },
  {
    id: 'granite-4.0-micro',
    hfRepoId: 'ibm-granite/granite-4.0-micro',
    label: 'Granite 4.0 Micro',
    license: 'apache-2.0',
    usable: true,
  },
  {
    id: 'midm-2.0-mini',
    hfRepoId: 'K-intelligence/Midm-2.0-Mini-Instruct',
    label: 'Midm 2.0 Mini Instruct',
    license: 'mit',
    usable: true,
  },
  {
    id: 'lfm25-230m',
    hfRepoId: 'LiquidAI/LFM2.5-230M',
    label: 'LFM2.5 230M',
    license: 'lfm1.0',
    usable: true,
    notes: 'Commercial use only below $10M revenue.',
  },
  {
    id: 'lfm25-350m',
    hfRepoId: 'LiquidAI/LFM2.5-350M',
    label: 'LFM2.5 350M',
    license: 'lfm1.0',
    usable: true,
    notes: 'Commercial use only below $10M revenue.',
  },
  {
    id: 'lfm25-1.2b',
    hfRepoId: 'LiquidAI/LFM2.5-1.2B-Instruct',
    label: 'LFM2.5 1.2B Instruct',
    license: 'lfm1.0',
    usable: true,
    notes: 'Commercial use only below $10M revenue.',
  },
  {
    id: 'lfm25-1.2b-thinking',
    hfRepoId: 'LiquidAI/LFM2.5-1.2B-Thinking',
    label: 'LFM2.5 1.2B Thinking',
    license: 'lfm1.0',
    usable: true,
    notes:
      'Emits a thinking block before the call, which the parser strips. Commercial use only below $10M revenue.',
  },
  {
    id: 'lfm25-2.6b',
    hfRepoId: 'LiquidAI/LFM2.5-2.6B',
    label: 'LFM2.5 2.6B',
    license: 'lfm1.0',
    usable: true,
    notes:
      'Always thinks before it answers - the template opens the block, so no request flag turns it off. Commercial use only below $10M revenue.',
  },
  {
    id: 'lfm25-8b-a1b',
    hfRepoId: 'LiquidAI/LFM2.5-8B-A1B',
    label: 'LFM2.5 8B A1B MoE',
    license: 'lfm1.0',
    usable: true,
    notes: '8B total, 1B active. Commercial use only below $10M revenue.',
  },
  {
    id: 'hammer2.1-0.5b',
    hfRepoId: 'MadeAgents/Hammer2.1-0.5b',
    label: 'Hammer2.1 0.5B',
    license: 'cc-by-nc-4.0',
    usable: 'eval_only',
    notes: 'Non-commercial - eval_only; never in the default run set.',
  },
  {
    id: 'hammer2.1-1.5b',
    hfRepoId: 'MadeAgents/Hammer2.1-1.5b',
    label: 'Hammer2.1 1.5B',
    license: 'cc-by-nc-4.0',
    usable: 'eval_only',
    notes: 'Non-commercial - eval_only; never in the default run set.',
  },
];

export function listDefaultToolRoutingModels(): ToolRoutingModel[] {
  return TOOL_ROUTING_MODELS.filter((m) => m.usable === true);
}

export function listToolRoutingModels(opts?: {
  includeEvalOnly?: boolean;
}): ToolRoutingModel[] {
  if (opts?.includeEvalOnly) return [...TOOL_ROUTING_MODELS];
  return listDefaultToolRoutingModels();
}

export function getToolRoutingModel(id: string): ToolRoutingModel | undefined {
  return TOOL_ROUTING_MODELS.find((m) => m.id === id);
}
