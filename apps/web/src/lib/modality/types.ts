import type { EvalStreamEvent } from '@redrob/harness';

/**
 * A modality is everything Compare needs to know about a kind of output.
 *
 * Adding audio later means adding one adapter here, not restructuring Compare:
 * the setup, run, preference and route stages all speak this interface.
 */
export type ModalityId = 'text' | 'image';

export interface ModalityPrompt {
  id: string;
  input: string;
  /** Reference answer, when the task has one. */
  gold?: string;
}

export interface ModalityRunRequest {
  modelIds: string[];
  /** Catalog dataset id; adapters that support one may use it instead of prompts. */
  datasetId?: string;
  prompts?: ModalityPrompt[];
  promptSetLabel?: string;
  sampleCount: number;
  /** Image only: which prompt suite to draw from when no prompts are given. */
  suiteId?: string;
  seed?: number;
}

export interface JudgeSide {
  modelId: string;
  /** Whatever the run produced: completion text, or an artifact URL. */
  answer: string;
}

export interface JudgeVerdict {
  winner: 'a' | 'b' | 'tie';
  rationale: string;
}

export interface ModalityAdapter {
  id: ModalityId;
  label: string;
  /**
   * How a competitor's answer is displayed in a vote card. `image` answers are
   * URLs the browser can load; `text` answers are the completion itself.
   */
  answerKind: 'text' | 'image';
  /**
   * Whether this modality can score an answer without a human. Image
   * generation has no reference to match, so it always goes to preference.
   */
  autoScorable: boolean;
  /** Which model-catalog filter the setup stage should apply. */
  catalogFilter: 'text' | 'image';
  /**
   * Generate every model × prompt cell, streaming the same event shape the
   * text eval emits so the Compare client has one code path.
   */
  run(
    req: ModalityRunRequest,
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<EvalStreamEvent, void, unknown>;
  /**
   * Optional model judge for one blind match, so a voter can hand a long
   * bracket to a judge and override anything they disagree with. Undefined
   * means this modality is human-only.
   */
  judgeMatch?(params: {
    promptText: string;
    a: JudgeSide;
    b: JudgeSide;
    judgeModelId?: string;
  }): Promise<JudgeVerdict>;
}
