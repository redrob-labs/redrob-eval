import { createRunStore } from '@redrob/harness';
import type { NewRun, NewRunEvent, RunJson, RunPatch, RunRecord } from '@redrob/harness';

/**
 * Recording a run must never be able to break the run.
 *
 * The registry is bookkeeping. A researcher whose eight-minute sweep died
 * because a log directory was read-only would be right to rip it out, so every
 * call here swallows its own failure and reports it once to the server log.
 * The consequence is deliberate: a missing record is a gap in history, not a
 * lost result.
 */

let warned = false;

function warnOnce(error: unknown): void {
  if (warned) return;
  warned = true;
  console.warn(
    '[registry] recording is disabled for this process:',
    error instanceof Error ? error.message : error,
  );
}

/** A handle that behaves the same whether or not the store is reachable. */
export interface RunRecorder {
  readonly id: string | null;
  event(event: NewRunEvent): Promise<void>;
  artifact(name: string, data: RunJson): Promise<void>;
  finish(patch: RunPatch): Promise<void>;
}

const NOOP: RunRecorder = {
  id: null,
  async event() {},
  async artifact() {},
  async finish() {},
};

export async function startRun(input: NewRun): Promise<RunRecorder> {
  let store;
  let run: RunRecord;
  try {
    store = await createRunStore();
    run = await store.create(input);
  } catch (error) {
    warnOnce(error);
    return NOOP;
  }

  const settled = { done: false };
  return {
    id: run.id,
    async event(event) {
      try {
        await store.appendEvents(run.id, [event]);
      } catch (error) {
        warnOnce(error);
      }
    },
    async artifact(name, data) {
      try {
        await store.putArtifact(run.id, name, data);
      } catch (error) {
        warnOnce(error);
      }
    },
    async finish(patch) {
      if (settled.done) return;
      settled.done = true;
      try {
        await store.update(run.id, patch);
        await store.close();
      } catch (error) {
        warnOnce(error);
      }
    },
  };
}

/** Narrow a value to something the registry can store without inspecting it. */
export function asJson(value: unknown): RunJson {
  return JSON.parse(JSON.stringify(value ?? null)) as RunJson;
}
