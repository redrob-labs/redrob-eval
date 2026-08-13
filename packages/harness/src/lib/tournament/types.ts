/**
 * Blind World Cup preference.
 *
 * One bracket per prompt. Competitors are the models' answers to that prompt,
 * so a "match" is two answers to the same question shown side by side with
 * model identity hidden. The winner advances, and the champion of each prompt
 * is that prompt's preferred model.
 */

/** A model's answer to one prompt — the thing being voted on. */
export interface Competitor {
  /** Canonical model id */
  modelId: string;
  label: string;
  /** The model's answer text (or an image artifact path for image modality) */
  answer: string;
  /** Set when the model errored on this prompt; auto-loses every match. */
  error?: string;
}

export type VoteWinner = 'a' | 'b' | 'tie';

export interface Match {
  matchId: string;
  round: number;
  /** Slot index within the round, used to derive the next round's pairing. */
  slot: number;
  a: string | null;
  b: string | null;
  /**
   * Resolved winner's model id. A bye resolves immediately; a tie resolves to
   * `a` for advancement while still being recorded as a tie in the vote log.
   */
  winnerModelId: string | null;
  /** True when the slot advanced without a vote because there was no opponent. */
  bye: boolean;
}

/**
 * A single vote over every answer at once, used when the field is small enough
 * to read side by side. A bracket of three would otherwise pad to four and walk
 * one model into the next round unopposed, which decides a prompt without
 * anyone having looked at that answer.
 */
export interface GroupMatch {
  matchId: string;
  /** Every answer on screen, in the bracket's seeded order. */
  contenders: string[];
  winnerModelId: string | null;
  /** The voter called it, rather than the match being undecided. */
  tie: boolean;
  /**
   * Knocked out one at a time, worst first. Empty until someone votes that way.
   * Optional: ballots saved before elimination existed do not carry it.
   */
  eliminated?: string[];
  /**
   * Every contender in order, best first, once the ballot resolved by a full
   * ranking or by eliminating down to one. Null when the voter only named a
   * winner, which says nothing about how the rest place against each other.
   */
  ranking?: string[] | null;
}

export interface Bracket {
  promptId: string;
  promptText: string;
  competitors: Competitor[];
  /** Set instead of `rounds` for a small field. Exactly one of the two is used. */
  group: GroupMatch | null;
  rounds: Match[][];
  championModelId: string | null;
}

export interface Vote {
  promptId: string;
  matchId: string;
  round: number;
  /** Model shown on the left */
  aModelId: string;
  /** Model shown on the right */
  bModelId: string;
  winner: VoteWinner;
  /** Model the voter picked, or null for a tie. */
  winnerModelId: string | null;
  votedAt: string;
}

/**
 * A prompt the voter went back to and cleared, so its bracket starts over.
 *
 * The vote log is append-only, and rewriting it to drop the retracted rows
 * would lose the fact that someone changed their mind. This is appended
 * instead, and reading the log applies it: every vote recorded for that prompt
 * before this entry stops counting.
 */
export interface VoteUndo {
  kind: 'undo';
  promptId: string;
  undoneAt: string;
}

/** A line of `votes.jsonl`: a vote, or a retraction of a prompt's votes. */
export type VoteLogEntry = Vote | VoteUndo;

export function isVoteUndo(entry: VoteLogEntry): entry is VoteUndo {
  return (entry as VoteUndo).kind === 'undo';
}

export interface TournamentMeta {
  runId: string;
  /** The eval run whose answers seeded this tournament */
  sourceRunId: string;
  modality: 'text' | 'image';
  modelIds: string[];
  promptIds: string[];
  createdAt: string;
  finishedAt: string | null;
}

export interface TournamentRun {
  meta: TournamentMeta;
  brackets: Bracket[];
  votes: Vote[];
}

/** Per-model outcome across every prompt bracket. */
export interface ModelStanding {
  modelId: string;
  label: string;
  /** Prompts where this model won its bracket */
  championOf: number;
  wins: number;
  losses: number;
  ties: number;
  /** wins / (wins + losses + ties), 0 when it never played */
  winRate: number;
}

export interface TournamentAggregate {
  /** Model that won the most prompt brackets, null when nothing is resolved */
  overallChampionModelId: string | null;
  standings: ModelStanding[];
  /** promptId -> winning model id (null while the bracket is unresolved) */
  winnerByPrompt: Record<string, string | null>;
  /**
   * promptId -> every competitor, best first. A knockout orders by how far each
   * answer got; a group ballot uses the order the voter gave. Empty for a
   * prompt nobody has finished voting on.
   */
  rankingByPrompt: Record<string, string[]>;
  /**
   * winMatrix[a][b] = how many times a beat b head to head.
   * Ties count for neither side.
   */
  winMatrix: Record<string, Record<string, number>>;
  matchesTotal: number;
  matchesVoted: number;
}
