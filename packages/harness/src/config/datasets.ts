/**
 * Eval dataset catalog — add entries freely.
 * Each entry maps a Hugging Face dataset (+ config/split) to a metric.
 */

export type MetricId = 'chrf' | 'accuracy' | 'gsm8k_exact' | 'llm_judge';

export type DatasetTask = 'translation' | 'classification' | 'math' | 'custom';

export interface HfSource {
  /** Hugging Face dataset id, e.g. openai/gsm8k */
  dataset: string;
  /** HF config / subset name */
  config: string;
  /** Split name */
  split: string;
  /**
   * Optional ungated mirror used when the primary dataset is gated
   * and HF_TOKEN is missing (e.g. mteb/IN22-Gen for ai4bharat/IN22-Gen).
   */
  fallbackDataset?: string;
}

export interface DatasetRef {
  /** Stable id used in API / cache keys */
  id: string;
  label: string;
  task: DatasetTask;
  metric: MetricId;
  hf: HfSource;
  /**
   * Field mapping from raw HF row → eval sample.
   * Paths are top-level keys on the row object.
   */
  fields: {
    /** Prompt / source text field */
    input: string;
    /** Gold reference field (string, or ClassLabel int coerced to string) */
    gold: string;
    /** Optional second choice field (e.g. COPA) — unused in default set */
    choiceA?: string;
    choiceB?: string;
  };
  /** Hard cap per load (default 200) */
  maxSamples: number;
  /** Fixed seed for reproducible subsample */
  seed: number;
  /** How many rows to pull from HF before seeded subsample (default = maxSamples * 3, capped) */
  poolSize?: number;
  notes?: string;
}

/** Default eval suites — replace / extend as needed. */
export const EVAL_DATASETS: DatasetRef[] = [
  {
    id: 'in22-gen-hi-en',
    label: 'IN22-Gen Hindi→English',
    task: 'translation',
    metric: 'chrf',
    hf: {
      dataset: 'ai4bharat/IN22-Gen',
      // Same n-way parallel sentences; ungated mirror for datasets-server
      fallbackDataset: 'mteb/IN22-Gen',
      config: 'default',
      split: 'test',
    },
    fields: {
      input: 'hin_Deva',
      gold: 'eng_Latn',
    },
    maxSamples: 200,
    seed: 42,
    notes: 'Indic↔English translation; scored with chrF. Vendored under datasets/ (CC-BY-4.0).',
  },
  {
    id: 'indic-glue-iitp-mr-hi',
    label: 'IndicGLUE IITP-MR (Hindi sentiment)',
    task: 'classification',
    metric: 'accuracy',
    hf: {
      dataset: 'ai4bharat/indic_glue',
      config: 'iitp-mr.hi',
      split: 'test',
    },
    fields: {
      input: 'text',
      gold: 'label',
    },
    maxSamples: 200,
    seed: 42,
    notes:
      'Movie-review sentiment. Not committed (CC-BY-NC / external terms). Run yarn datasets:fetch --id=indic-glue-iitp-mr-hi → datasets/local/.',
  },
  {
    id: 'accuracy-fixture',
    label: 'Synthetic Hindi sentiment (fixture)',
    task: 'classification',
    metric: 'accuracy',
    hf: {
      dataset: 'synthetic',
      config: 'default',
      split: 'test',
    },
    fields: {
      input: 'input',
      gold: 'gold',
    },
    maxSamples: 5,
    seed: 42,
    notes: 'Apache-2.0 synthetic fixture for offline accuracy smoke tests.',
  },
  {
    id: 'gsm8k-main',
    label: 'GSM8K (main)',
    task: 'math',
    metric: 'gsm8k_exact',
    hf: {
      dataset: 'openai/gsm8k',
      config: 'main',
      split: 'test',
    },
    fields: {
      input: 'question',
      gold: 'answer',
    },
    maxSamples: 200,
    seed: 42,
    notes: 'Grade-school math; exact match on extracted numeric answer. Vendored under datasets/ (MIT).',
  },
];

export function getDatasetById(id: string): DatasetRef | undefined {
  return EVAL_DATASETS.find((d) => d.id === id);
}

export function listDatasets(): DatasetRef[] {
  return EVAL_DATASETS;
}
