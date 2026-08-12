/**
 * Generate has two stages and they answer different questions. Templates is "what items
 * exist and what does one look like"; Study is "run the whole design and show me the
 * numbers". Neither depends on the other, so both are reachable from the start.
 */
export type GenerateStage = 'templates' | 'study';

export const STAGE_ORDER: GenerateStage[] = ['templates', 'study'];

export const STAGE_LABELS: Record<GenerateStage, string> = {
  templates: 'Templates',
  study: 'Study',
};

export type TranslationStatus = 'native-reviewed' | 'single-reviewer' | 'untranslated';

export interface CatalogLocale {
  tag: string;
  translationStatus: TranslationStatus;
  promptCharacters: number;
}

export interface CatalogTemplate {
  id: string;
  title: string;
  version: string;
  family: string;
  familyLabel: string;
  path: string;
  description?: string;
  verifierFamily: string;
  parameterCount: number;
  locales: CatalogLocale[];
}

export interface StudyConfigSummary {
  path: string;
  id: string;
  title: string;
  description?: string;
  templateCount: number;
  localeTags: string[];
  modelIds: string[];
  tokenizer: string;
  offline: boolean;
}

export type PythonUnavailableCode =
  | 'not-found'
  | 'not-executable'
  | 'timed-out'
  | 'spawn-failed'
  | 'version-failed';

export interface GenerateStatus {
  python:
    | { available: true; version: string }
    | {
        available: false;
        /** English, for a log or a bug report. Prefer `reasonCode` on screen. */
        reason: string;
        reasonCode?: PythonUnavailableCode;
        command?: string;
      };
  repoRoot: string | null;
  runtimes: {
    implementation: string;
    implementationVersion: string;
    unicodeVersion: string;
    authoritative: boolean;
  }[];
}

export interface PreviewInstance {
  template_id: string;
  locale: string;
  instance_index: number;
  seed: string;
  prompt: string;
  parameters: Record<string, unknown>;
  derived?: Record<string, unknown>;
  verifier: unknown;
  code_mix_ratio: number | null;
}

export interface StudyRuntime {
  implementation: string;
  implementation_version: string;
  unicode_version: string;
  authoritative: boolean;
}

export interface StudyResultLocale {
  tag: string;
  fertility_level: 'low' | 'high';
  resource_level: 'low' | 'high';
  translation_status: TranslationStatus;
}

export interface AccuracyRow {
  model_id: string;
  locale: string;
  verifier_family: string;
  n: number;
  passed: number;
  accuracy: number;
}

export interface TokenRow {
  locale: string;
  n: number;
  mean_prompt_tokens: number;
}

export interface PairedDelta {
  comparison: string;
  left: string;
  right: string;
  n_pairs: number;
  dropped_unpaired: number;
  mean_prompt_tokens_left: number;
  mean_prompt_tokens_right: number;
  mean_prompt_tokens_delta: number;
  accuracy_left: number;
  accuracy_right: number;
  accuracy_delta: number;
}

export interface StudyResult {
  study_id: string;
  study_version: string;
  provenance: {
    generator_version: string;
    spec_version: string;
    tokenizer: { name: string; version: string };
    runtimes: StudyRuntime[];
    created_at: string;
  };
  locales: StudyResultLocale[];
  instances: { verdict_provenance: StudyRuntime }[];
  aggregates: {
    accuracy: AccuracyRow[];
    tokens: TokenRow[];
    paired_deltas: PairedDelta[];
  };
}

export interface StudyRunResponse {
  result: StudyResult;
  table: string;
  publishable: boolean;
  refusal?: string;
}

/** Short label and tone for a translation status chip. */
export const STATUS_TONE: Record<TranslationStatus, { label: string; tone: string }> = {
  'native-reviewed': { label: 'native reviewed', tone: 'ok' },
  'single-reviewer': { label: 'single reviewer', tone: 'warn' },
  untranslated: { label: 'untranslated', tone: 'stub' },
};
