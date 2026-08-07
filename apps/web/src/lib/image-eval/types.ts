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
