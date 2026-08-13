/**
 * A normalised, classified failure.
 *
 * A rate tells you how often a model was wrong. It never tells you *how*, and
 * "how" is the only thing that changes what you do next: a model that picks the
 * right tool and formats it wrong needs a parser or a prompt, one that picks the
 * wrong tool needs better descriptions, and one that acts when it should have
 * declined needs something else again. Those three are the same number in an
 * accuracy column.
 *
 * So failures are pulled out of reports into one shape and given a kind. The
 * shape is shared across task types on purpose - a tool-routing example and a
 * multi-turn turn become the same record - so one workspace can filter, tally and
 * compare them without knowing which harness produced them.
 */

/**
 * Why a failure happened, in terms that suggest a fix.
 *
 * Kept small and deliberately not one-per-harness: `format` means the same thing
 * whether it came from a routing task or the fourth turn of a conversation.
 */
export type FailureKind =
  /** The reply did not follow the required shape at all. */
  | 'format'
  /** The right decision through the wrong wrapper - recoverable, and telling. */
  | 'envelope'
  /** A tool was chosen, but not the right one. */
  | 'wrong_tool'
  /** The right tool with the wrong arguments. */
  | 'bad_arguments'
  /** Should have declined; acted instead. */
  | 'missed_abstention'
  /** Declined, but the wrong way - BLOCK where DEFER was owed, or the reverse. */
  | 'wrong_abstention'
  /** Called a tool when the answer was already in the transcript. */
  | 'spurious_call'
  /** An instruction given earlier, and not repeated, was dropped. */
  | 'instruction_dropped'
  /** A fact the user stated earlier was not used. */
  | 'context_lost'
  /** A correction the user made was not applied. */
  | 'correction_ignored'
  /** The script expected a tool result for a call the model never made. */
  | 'desynced'
  /** The provider call itself failed. Not the model's answer, and not its fault. */
  | 'call_error'
  | 'other';

export const FAILURE_KINDS: FailureKind[] = [
  'format',
  'envelope',
  'wrong_tool',
  'bad_arguments',
  'missed_abstention',
  'wrong_abstention',
  'spurious_call',
  'instruction_dropped',
  'context_lost',
  'correction_ignored',
  'desynced',
  'call_error',
  'other',
];

/**
 * Failures a prompt or parser change could plausibly fix, as opposed to ones
 * that need a better model. Worth separating because the first group is work
 * you can do this afternoon.
 */
export const RECOVERABLE_KINDS: FailureKind[] = ['format', 'envelope', 'desynced'];

export interface FailureRecord {
  /** Stable within a run: `<model>|<item>` (plus the turn, when there is one). */
  id: string;
  kind: FailureKind;
  /** One line naming what went wrong, in the harness's own terms. */
  detail: string;
  /** Which harness produced it, e.g. `tool-routing` or `multi-turn`. */
  source: string;
  model: string;
  /** The task, scenario or sample this came from. */
  item: string;
  language?: string;
  /** Multi-turn: which turn, 1-based, and what it was testing. */
  turn?: number;
  capability?: string;
  /** Tool routing: the tool that was expected and the one that was produced. */
  expectedTool?: string;
  actualTool?: string;
  /** What should have happened, rendered for reading. */
  expected?: string;
  /** Exactly what came back, before parsing. */
  actual?: string;
  /** The prompt, when the report kept it. */
  prompt?: string;
}

export interface FailureTally {
  kind: FailureKind;
  count: number;
  /** Share of all failures in the set. */
  share: number;
}
