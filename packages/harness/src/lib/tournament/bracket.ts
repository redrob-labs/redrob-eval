import type { Bracket, Competitor, Match, Vote, VoteWinner } from './types';

/**
 * Single-elimination bracket, one per prompt.
 *
 * The field is padded to a power of two with byes so every round is a clean
 * halving. Byes are placed at the end of the seeding order, which means the
 * models listed first get them — seed your strongest candidates first if that
 * matters to you.
 */

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * Deterministic shuffle so the same prompt always produces the same pairing.
 * Blind voting only works if the order does not leak model identity, and a
 * seeded shuffle keeps that stable across reloads.
 */
function seededOrder<T>(items: T[], seed: string): T[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    const j = Math.abs(h) % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function matchId(promptId: string, round: number, slot: number): string {
  return `${promptId}:r${round}:m${slot}`;
}

/** Build the full round structure, resolving byes and errored competitors. */
export function createBracket(params: {
  promptId: string;
  promptText: string;
  competitors: Competitor[];
}): Bracket {
  const { promptId, promptText } = params;
  const competitors = params.competitors;

  if (competitors.length === 0) {
    return { promptId, promptText, competitors, rounds: [], championModelId: null };
  }
  if (competitors.length === 1) {
    return {
      promptId,
      promptText,
      competitors,
      rounds: [],
      championModelId: competitors[0]!.modelId,
    };
  }

  const seeded = seededOrder(competitors, promptId);
  const size = nextPowerOfTwo(seeded.length);
  const slots: Array<string | null> = seeded.map((c) => c.modelId);
  while (slots.length < size) slots.push(null);

  const rounds: Match[][] = [];
  // `null` means the slot is permanently empty (padding), `undefined` means a
  // real match will decide it later. Keeping those apart is what makes the bye
  // count correct for fields that are not a power of two.
  let current: Array<string | null | undefined> = slots;
  let round = 0;

  while (current.length > 1) {
    const matches: Match[] = [];
    const next: Array<string | null | undefined> = [];
    for (let i = 0; i < current.length; i += 2) {
      const a = current[i];
      const b = current[i + 1];
      const slot = i / 2;
      const aEmpty = a === null;
      const bEmpty = b === null;
      const bothEmpty = aEmpty && bEmpty;
      // Exactly one side permanently empty means whoever lands opposite it
      // walks through without a vote, even if that side is still undecided.
      const walkover = !bothEmpty && (aEmpty || bEmpty);
      const decided = walkover ? ((a ?? b) as string | undefined) ?? null : null;

      matches.push({
        matchId: matchId(promptId, round, slot),
        round,
        slot,
        a: typeof a === 'string' ? a : null,
        b: typeof b === 'string' ? b : null,
        winnerModelId: decided,
        bye: bothEmpty || walkover,
      });
      next.push(bothEmpty ? null : (decided ?? undefined));
    }
    rounds.push(matches);
    current = next;
    round += 1;
  }

  const bracket: Bracket = {
    promptId,
    promptText,
    competitors,
    rounds,
    championModelId: null,
  };

  // A model that errored cannot win, so resolve those matches without a vote.
  const errored = new Set(competitors.filter((c) => c.error).map((c) => c.modelId));
  if (errored.size) resolveErrorWalkovers(bracket, errored);

  settleByes(bracket);
  bracket.championModelId = championOf(bracket);
  return bracket;
}

function resolveErrorWalkovers(bracket: Bracket, errored: Set<string>): void {
  for (const match of bracket.rounds.flat()) {
    if (match.winnerModelId || !match.a || !match.b) continue;
    const aBad = errored.has(match.a);
    const bBad = errored.has(match.b);
    if (aBad === bBad) continue;
    applyWinner(bracket, match, aBad ? match.b : match.a);
  }
}

/** Write a winner into a match, propagate it forward, then settle new byes. */
function applyWinner(bracket: Bracket, match: Match, winnerModelId: string): void {
  match.winnerModelId = winnerModelId;
  const nextRound = bracket.rounds[match.round + 1];
  if (nextRound) {
    const nextMatch = nextRound[Math.floor(match.slot / 2)];
    if (nextMatch) {
      if (match.slot % 2 === 0) nextMatch.a = winnerModelId;
      else nextMatch.b = winnerModelId;
    }
  }
  settleByes(bracket);
}

/**
 * Auto-advance any match whose opponent slot can never be filled. This happens
 * whenever the field is not a power of two, so a competitor walks into the next
 * round unopposed.
 */
function settleByes(bracket: Bracket): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (let round = 0; round < bracket.rounds.length; round += 1) {
      for (const match of bracket.rounds[round]!) {
        if (match.winnerModelId || !match.bye) continue;
        const sole = match.a ?? match.b;
        if (!sole) continue;
        match.winnerModelId = sole;
        const nextMatch = bracket.rounds[round + 1]?.[Math.floor(match.slot / 2)];
        if (nextMatch) {
          if (match.slot % 2 === 0) nextMatch.a = sole;
          else nextMatch.b = sole;
        }
        changed = true;
      }
    }
  }
}

/** The next match a human still has to vote on, or null when nothing is pending. */
export function nextPendingMatch(bracket: Bracket): Match | null {
  for (const round of bracket.rounds) {
    for (const match of round) {
      if (match.winnerModelId) continue;
      if (match.a && match.b) return match;
    }
  }
  return null;
}

/**
 * Record a vote and advance the bracket. Ties advance side A so the bracket
 * can finish, but the vote log keeps the tie so routing labels can honour it.
 */
export function advance(
  bracket: Bracket,
  matchId_: string,
  winner: VoteWinner,
): { bracket: Bracket; vote: Vote } {
  const match = bracket.rounds.flat().find((m) => m.matchId === matchId_);
  if (!match) throw new Error(`Unknown match: ${matchId_}`);
  if (!match.a || !match.b) throw new Error(`Match ${matchId_} has no opponent pair yet`);
  if (match.winnerModelId) throw new Error(`Match ${matchId_} is already resolved`);

  const advancing = winner === 'b' ? match.b : match.a;
  applyWinner(bracket, match, advancing);
  bracket.championModelId = championOf(bracket);

  return {
    bracket,
    vote: {
      promptId: bracket.promptId,
      matchId: match.matchId,
      round: match.round,
      aModelId: match.a,
      bModelId: match.b,
      winner,
      winnerModelId: winner === 'tie' ? null : advancing,
      votedAt: new Date().toISOString(),
    },
  };
}

export function championOf(bracket: Bracket): string | null {
  if (!bracket.rounds.length) return bracket.competitors[0]?.modelId ?? null;
  const final = bracket.rounds[bracket.rounds.length - 1]![0];
  return final?.winnerModelId ?? null;
}

export function totalMatches(bracket: Bracket): number {
  return bracket.rounds.flat().filter((m) => !m.bye).length;
}

export function resolvedMatches(bracket: Bracket): number {
  return bracket.rounds.flat().filter((m) => !m.bye && m.winnerModelId).length;
}
