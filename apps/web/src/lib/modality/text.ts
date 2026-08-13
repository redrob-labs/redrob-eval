import { runEval } from '@redrob/harness';
import type { ModalityAdapter } from './types';

/** Text answers come from the shared eval runner, scored against gold when present. */
export const textModality: ModalityAdapter = {
  id: 'text',
  label: 'Text',
  answerKind: 'text',
  autoScorable: true,
  catalogFilter: 'text',
  run(req, opts) {
    return runEval(
      {
        datasetId: req.datasetId,
        prompts: req.prompts,
        promptSetLabel: req.promptSetLabel,
        promptMetric: req.promptMetric,
        sampleCount: req.sampleCount,
        modelIds: req.modelIds,
      },
      opts,
    );
  },
};
