export type ImageSuitePrompt = {
  id: string;
  prompt: string;
  style?: string;
  subject?: string;
  difficulty?: string;
  tags?: string[];
  aspectRatio?: string;
  negativePrompt?: string;
};

export type ImageSuite = {
  version: number;
  suite: string;
  description: string;
  rating: 'sfw';
  path: 'sfw';
  modality: 'image';
  scoring: 'preference';
  notes?: string[];
  prompts: ImageSuitePrompt[];
};

export type ImagePreferenceRating = {
  suite: string;
  prompt_id: string;
  models: string[];
  winner: string;
  notes: string;
  /** human | auto | mixed */
  source?: 'human' | 'auto' | 'mixed';
  auto?: {
    winner: string;
    rationale?: string;
    scores?: {
      modelId: string;
      promptAdherence: number;
      overall: number;
      notes?: string;
    }[];
  };
};

export type ImageRunMeta = {
  runId: string;
  suiteId: string;
  createdAt: string;
  seed: number;
  modelIds: string[];
  modelLabels: Record<string, string>;
  promptIds: string[];
  status: 'running' | 'ready' | 'failed';
  error?: string;
  autoJudge?: boolean;
  judgeModelId?: string;
  scoring: 'preference';
};

export type ImageArtifact = {
  modelId: string;
  promptId: string;
  seed: number;
  relativePath: string;
  latencyMs?: number;
  error?: string;
};

export type ImageRunStreamEvent =
  | {
      type: 'start';
      runId: string;
      total: number;
      promptCount: number;
      models: Array<{ id: string; label: string }>;
    }
  | {
      type: 'progress';
      done: number;
      total: number;
      modelId: string;
      promptId: string;
      ok: boolean;
      message?: string;
    }
  | { type: 'judging'; promptId: string }
  | { type: 'done'; runId: string; meta: ImageRunMeta }
  | { type: 'cancelled'; runId?: string; message?: string }
  | { type: 'error'; message: string; runId?: string };
