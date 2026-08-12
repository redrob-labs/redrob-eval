import { promises as fs } from 'node:fs';
import path from 'node:path';
import { evalRoot } from '../paths';
import type {
  Bracket,
  TournamentMeta,
  TournamentRun,
  Vote,
  VoteLogEntry,
  VoteUndo,
} from './types';
import { isVoteUndo } from './types';

/**
 * Tournaments live under `eval/tournaments/{runId}/`, matching the layout the
 * other run types use: a `meta.json` snapshot plus append-only `votes.jsonl`
 * so a vote is never lost to a crash mid-session.
 */

function tournamentsDir(): string {
  return path.join(evalRoot(), 'tournaments');
}

const RUN_ID_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}_[a-z0-9-]+$/i;

export function assertSafeTournamentRunId(runId: string): string {
  if (!runId || !RUN_ID_RE.test(runId)) throw new Error('Invalid tournament run id');
  return runId;
}

export function makeTournamentRunId(sourceRunId: string): string {
  const now = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}_${p(
    now.getHours(),
  )}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const slug = sourceRunId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 24) || 'run';
  return `${stamp}_${slug}`;
}

function runDir(runId: string): string {
  return path.join(tournamentsDir(), assertSafeTournamentRunId(runId));
}

export async function writeTournament(run: TournamentRun): Promise<void> {
  const dir = runDir(run.meta.runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'meta.json'),
    `${JSON.stringify({ meta: run.meta, brackets: run.brackets }, null, 2)}\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(dir, 'votes.jsonl'),
    run.votes.map((v) => JSON.stringify(v)).join('\n') + (run.votes.length ? '\n' : ''),
    'utf8',
  );
}

/** Rewrite meta + brackets only; votes stay append-only. */
export async function writeTournamentMeta(
  meta: TournamentMeta,
  brackets: Bracket[],
): Promise<void> {
  const dir = runDir(meta.runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'meta.json'),
    `${JSON.stringify({ meta, brackets }, null, 2)}\n`,
    'utf8',
  );
}

export async function appendVote(runId: string, vote: Vote): Promise<void> {
  await appendVotes(runId, [vote]);
}

/** One write, so a group vote's pairwise rows cannot land half-written. */
export async function appendVotes(runId: string, votes: Vote[]): Promise<void> {
  if (votes.length === 0) return;
  const dir = runDir(runId);
  await fs.mkdir(dir, { recursive: true });
  const lines = votes.map((v) => `${JSON.stringify(v)}\n`).join('');
  await fs.appendFile(path.join(dir, 'votes.jsonl'), lines, 'utf8');
}

/**
 * Retract one prompt's votes so it can be voted again.
 *
 * Appended like any other line rather than rewritten over the retracted rows:
 * the log stays a record of what happened, including the change of mind.
 */
export async function appendVoteUndo(
  runId: string,
  promptId: string,
): Promise<VoteUndo> {
  const undo: VoteUndo = { kind: 'undo', promptId, undoneAt: new Date().toISOString() };
  const dir = runDir(runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, 'votes.jsonl'), `${JSON.stringify(undo)}\n`, 'utf8');
  return undo;
}

/** Apply the retractions in a raw log, leaving the votes that still count. */
export function foldVoteLog(entries: VoteLogEntry[]): Vote[] {
  const votes: Vote[] = [];
  for (const entry of entries) {
    if (isVoteUndo(entry)) {
      for (let i = votes.length - 1; i >= 0; i -= 1) {
        if (votes[i]!.promptId === entry.promptId) votes.splice(i, 1);
      }
      continue;
    }
    votes.push(entry);
  }
  return votes;
}

export async function readTournament(runId: string): Promise<TournamentRun> {
  const dir = runDir(runId);
  const metaRaw = await fs.readFile(path.join(dir, 'meta.json'), 'utf8');
  const parsed = JSON.parse(metaRaw) as { meta: TournamentMeta; brackets: Bracket[] };

  let votes: Vote[] = [];
  try {
    const votesRaw = await fs.readFile(path.join(dir, 'votes.jsonl'), 'utf8');
    votes = foldVoteLog(
      votesRaw
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as VoteLogEntry),
    );
  } catch {
    // no votes yet
  }

  return { meta: parsed.meta, brackets: parsed.brackets, votes };
}

export async function listTournaments(): Promise<TournamentMeta[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(tournamentsDir());
  } catch {
    return [];
  }
  const out: TournamentMeta[] = [];
  for (const id of entries) {
    try {
      const raw = await fs.readFile(path.join(tournamentsDir(), id, 'meta.json'), 'utf8');
      out.push((JSON.parse(raw) as { meta: TournamentMeta }).meta);
    } catch {
      // skip unreadable runs
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
