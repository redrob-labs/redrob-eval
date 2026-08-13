# Resumable job queue

A researcher's real unit of work is not one run, it is a grid: *these* models,
over *these* datasets, in *these* languages, under *these* conditions. That grid
takes long enough that something will interrupt it — a laptop sleeps, a provider
rate-limits, a token budget runs out — and re-running the cells that already
finished is both a waste and a way to get inconsistent numbers.

The queue treats the grid as cells, runs them under a concurrency budget it can
actually keep, and checkpoints each cell as it lands. Interrupt it, start it
again, and it picks up only what is left.

## Expanding a grid

```ts
const cells = expandMatrix({
  dimensions: {
    model: ['granite-4.1-8b', 'qwen3.5-9b', 'lfm2.5-2.6b'],
    language: ['en', 'ko'],
  },
  groupBy: 'model', // cells sharing a model share a concurrency cap
});
// 6 cells, each with a stable key derived from its combo
```

The key is a key-order-independent hash of the combo, so the same square gets
the same key on every run. That is the entire basis of resume: without stable
keys the queue cannot tell a finished cell from a new one.

## Running it

```ts
const result = await runMatrix({
  cells,
  concurrency: 4,            // at most 4 cells in flight across all groups
  perGroupConcurrency: 1,    // ...and at most 1 per provider
  maxAttempts: 3,            // retry a transient failure, not a broken cell
  checkpoint,                // where finished cells are remembered
  signal,                    // abort to pause; resume later from the checkpoint
  onProgress: (p) => console.error(`${p.done + p.failed}/${p.total}`),
  async worker(cell, { attempt, signal }) {
    return callSomething(cell.params, { signal });
  },
});
// result: { outcomes, done, failed, resumed, cancelled }
```

What each guarantee is for:

- **Global concurrency** bounds total inflight work, so a thousand-cell grid
  holds a handful of calls, not a thousand.
- **Per-group concurrency** is the one that matters in practice: group by
  provider and one provider's rate limit cannot be tripped by fanning out
  across models that share it.
- **Retry** is for the transient failure — a 429, a dropped socket — with
  exponential backoff. A cell that is wrong every time is tried `maxAttempts`
  times and then recorded as failed, not retried forever.
- **Failure isolation**: one bad cell is recorded and the grid keeps going. A
  sweep does not die because the eighth model 500'd.
- **Cancellation** aborts admission and hands the signal to each running
  worker, so a call can stop itself. A cell interrupted mid-flight records no
  outcome, so a resume runs it again rather than inventing a failure nobody
  caused.

## Resume, and where it is kept

The checkpoint is a two-method interface — which cells are already done, and
record one outcome — so it can be a `Map` in a test or the registry in
production:

```ts
const store = await createRunStore();
const run = await store.create({ kind: 'tool-routing-matrix', params: { models, languages } });
const checkpoint = runStoreCheckpoint(store, run.id);
```

`runStoreCheckpoint` writes each finished cell as one event on the
[registry](registry.md) run, and reads them back on resume. That is why the
registry's event log is append-only and existed before there was much writing to
it: a matrix is just a run with a lot of small events. Resume folds the history
and takes the last word on each key, so a cell that failed on Monday and
succeeded on Tuesday counts as done.

Because the checkpoint reads through the `RunStore`, resume works across
processes: kill the job, restart it tomorrow pointing at the same run id, and it
runs only the cells the first pass did not finish. The test suite proves this by
resuming through a second, independent store instance over the same directory.

## Design notes

- **The scheduler is a fixed worker pool pulling from a shared cursor**, not a
  promise per cell. A worker holding the last slot of a saturated group always
  loops back to drain that group's remaining cells, so no cell is orphaned and a
  single pass of `concurrency` workers suffices.
- **The queue is generic over the worker and the cell payload.** It never reads
  `params` or the worker's summary; both are opaque. New kinds of matrix need no
  change to the queue, the same way new kinds of run need no change to the
  registry.

## Running a grid as a registry run

`runRegistryMatrix` is the one verb that binds the queue to the
[registry](registry.md): it opens (or reopens) a run, checkpoints every cell to
that run's event log, drives the queue, and finalises the run's status. The
first producer built on it is a tool-routing matrix — one cell per
`(model, language)`:

```bash
yarn tool-routing:matrix --models granite-4.1-8b,qwen3.5-9b --languages en,ko --limit 20
# Ctrl-C to pause; it prints the resume command:
yarn tool-routing:matrix --resume 2026-08-13_023853_tool-routing-matrix
```

A resume reopens the same run, reruns only the cells that had not finished, and
rebuilds the results table from the registry — so the numbers a cancelled pass
produced are read back rather than lost. The dimensions, provider and sample
size are remembered on the run, so the resume flag is all that is needed; and a
resume whose parameters hash differently from the original is refused, so it
cannot quietly become a different experiment under the same id.

## Not done yet

- **No web UI.** The matrix runs from the CLI. A run-matrix screen that launches
  and watches one of these is the next step.
- **No cross-run cost accounting.** Estimated calls/tokens before launch and
  live usage totals belong on top of this.

## Related

- [Experiment registry](registry.md) — where a matrix's cells are checkpointed
- [Tool routing](tool-routing.md) — the obvious first matrix to run
