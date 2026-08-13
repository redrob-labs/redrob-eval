# Experiment registry

Every module here already produced runs, and each stored them its own way. That
is fine until you ask the questions a researcher asks every day:

- What did I run yesterday?
- Which of those failed, and why?
- Has this exact configuration already been run?
- What commit and what dataset produced this number?

Those are questions about runs in general, not about brackets or toolsets. The
registry answers them.

## The shape of a run

One small record that every kind of run shares, plus whatever the module wants
to keep, held as opaque JSON:

| Field | Why it is there |
| --- | --- |
| `id` | `2026-08-13_014210_tool-routing` — sortable, readable, short enough to cite |
| `kind` | Which module produced it. Free-form, so a new kind needs no schema change |
| `status` | `queued` / `running` / `done` / `failed` / `cancelled` |
| `label`, `tags` | How a person finds it again |
| `provenance` | Commit, dirty flag, params hash, models, dataset, runtime |
| `params` | What was asked for. Module-shaped; the registry never reads it |
| `summary` | Headline numbers. Module-shaped; the registry never reads it |
| `error` | Why it ended badly, in the module's own words |

The split is the whole design. The shared half is what makes runs listable,
comparable and citable; the opaque half is what stops the registry needing to
know about tool-routing slices or turn depth. Modules interlock with it rather
than being rebuilt around it.

**Provenance is captured, not asked for.** A field the caller has to remember to
fill in is empty on the run you most need it for, so commit, dirty flag, runtime
and params hash are all read from the machine when the run opens. It records
machine and repository facts only — no author or account. The tournament vote
log already refuses to record who voted, and a registry that quietly
reintroduced identity beside it would undo that.

The **params hash** is a key-order-independent hash of `params`, which is what
makes "have I already run this?" answerable:

```bash
yarn runs --kind tool-routing          # find the run
yarn runs show <id>                    # read its params hash
```

## Storage is configuration

The interface is fixed; the driver behind it is a setting. A laptop and a shared
lab machine want different answers and neither should have to fork anything.

```bash
REDROB_REGISTRY_DRIVER=fs        # default
REDROB_REGISTRY_DRIVER=sqlite
REDROB_REGISTRY_PATH=...         # directory for fs, file for sqlite
```

- **`fs`** (default) — one directory per run: `run.json` beside an append-only
  `events.jsonl`, the same layout `eval/tournaments/` already uses. Needs
  nothing installed and nothing running. You can `cat` a run, diff two of them,
  and commit one into a paper repo.
- **`sqlite`** — one file, for when there are thousands of runs and listing them
  means reading thousands of small files. `node:sqlite` ships with the runtime,
  so it costs no dependency; it is still experimental, so it is imported only
  when actually configured. Nobody on the default path pays for it.

Postgres is the obvious third driver and is deliberately absent: nothing needs a
server yet, and an unused driver is a maintenance cost that grows. It slots in
behind the same interface when a shared deployment wants one.

Filtering deliberately lives *above* the drivers. Two stores that disagree about
what `tags: ['a','b']` means would give different answers to the same question
depending on a config value set months ago, so a driver may narrow in its own
language first but the result always passes the same predicate. The test suite
is written once and run against every driver for the same reason.

## Using it

```bash
yarn runs                                   # last 20, newest first
yarn runs --kind tool-routing --status failed
yarn runs --tag paper,sub10b                # every tag must match, not any
yarn runs --model granite-4.1-8b
yarn runs --search granite
yarn runs show <id>
yarn runs show <id> --events
yarn runs show <id> --json
```

## Recording a run

```ts
const store = await createRunStore();
const run = await store.create({
  kind: 'tool-routing',
  params: { languages, models },
  models,
  tags: ['paper'],
});
await store.appendEvents(run.id, [{ level: 'info', message: 'granite finished' }]);
await store.update(run.id, { status: 'done', summary: { tasks: 81 } });
```

Inside the web app, use `startRun` from `@/lib/registry/record` instead. It
returns a handle that behaves identically whether or not the store is reachable,
because **recording a run must never be able to break the run.** A researcher
whose eight-minute sweep died because a log directory was read-only would be
right to rip the whole thing out. The consequence is deliberate: a store that
cannot be written is a gap in history, not a lost result.

Tool-routing sweeps started from Compare are recorded already, including the
per-slice numbers and the models that failed.

## Not done yet

- **No migration of existing runs.** The registry is forward-only by choice.
  `eval/tournaments/` and the rest keep working exactly as they did.
- **Producers.** A tool-routing sweep and a tool-routing matrix record; eval,
  tournaments and multi-turn do not yet.

The [resumable job queue](job-queue.md) is built on this: the `queued` status
and the append-only event log were the hooks for it, and a matrix now
checkpoints its cells into a run's events so it can be paused and resumed.

## Related

- [Tool routing](tool-routing.md) — the first producer
- [Methodology](methodology.md) — routing labels, features, export
