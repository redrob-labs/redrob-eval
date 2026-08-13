# Changelog

Newest first. The release model is in [CONTRIBUTING.md](CONTRIBUTING.md): work integrates on
`develop`, a `release/x.y.z` branch freezes it, `main` receives the merge and carries the tag.

This file starts at 0.2.0. Everything before it is readable in the history but was never gathered
here, and 0.1.0 shipped without a tag, so `v0.2.0` is the first release a reader can obtain by
name.

## 0.2.2 - 2026-08-13

### Fixed

- **A QA screenshot reached `v0.2.1`.** `.artifacts/` was not ignored, so a `git add -A` on the
  hotfix branch swept a 54 kB PNG into the release. The file is removed and the directory is now
  ignored: screenshots taken while checking a change by hand are evidence for a review, not
  repository history.

## 0.2.1 - 2026-08-13

### Fixed

- **`yarn install --frozen-lockfile` failed on a clean checkout of 0.2.0.** The version bump moved
  the four packages to `0.2.0` but left `apps/web` asking for `@redrob/harness@0.1.0` and
  `@redrob/harness` asking for `@redrob/tokenizers@0.1.0`, so yarn stopped resolving them from the
  workspace and looked for private packages on npm. Every CI job that installs failed, while a
  local install kept working because `node_modules` was already linked. The workspaces now depend
  on each other by `"*"`, which resolves to the workspace whatever the version, so a future bump
  cannot reintroduce this. `CONTRIBUTING.md` says so, and says to run a frozen-lockfile install on
  the release branch, which is the check that would have caught it.

## 0.2.0 - 2026-08-13

0.1.0 could compare models and settle quality by human preference. 0.2.0 is about what happens
after a number appears: where the run is recorded, how it resumes, why a model was wrong, and
whether a difference between two models is real. The browser path from generating a benchmark to
analysing it now runs end to end without touching a CLI.

### Added

- **Experiment registry** (#10). One small record every kind of run shares, with what the module
  did kept as opaque JSON, so a new kind of run plugs in without the registry changing. Provenance
  is captured rather than asked for: commit, dirty flag, params hash, runtime, and machine facts
  only. Storage is configuration, with a filesystem driver by default and a `node:sqlite` driver
  for thousands of runs; filtering lives above both and the suite runs against each. `yarn runs`
  lists and filters them.
- **Resumable job queue** (#11). A grid becomes cells with stable keys, run under a global and
  per-group concurrency budget so one provider's rate limit is never tripped, with retries for
  transient failures, isolation for a bad cell, and a checkpoint as each lands. Resume is a
  two-method interface: a map in a test, the registry's append-only event log in production, so
  resume works across processes.
- **Grids as one registry run** (#12). `runRegistryMatrix` opens or reopens a run, checkpoints
  every cell, drives the queue and finalises status. A resume whose parameters hash differently is
  refused rather than quietly becoming a different experiment under one id. First producer:
  `yarn tool-routing:matrix`, one cell per model and language, resumable with `--resume`.
- **Failure analysis** (#13). A shared, ordered taxonomy that separates a model which routes
  correctly and formats badly from one that picks the wrong tool from one that acts where it should
  have declined, because those need a parser fix, better tool descriptions, and something else
  again. The registry gained artifacts, so `yarn failures` triages a run from its stored output
  without re-calling anything, and `format`, `envelope` and `desynced` are marked recoverable.
- **Cohorts, hand corrections and paired statistics** (#14). A filtered set of failures saves as a
  cohort and re-runs through the queue; a misclassified failure can be corrected by hand without
  editing the artifact. Comparisons report Wilson intervals, exact McNemar, a seeded paired
  bootstrap difference and Holm adjustment across pairs, and warn when the shared item count
  cannot support the claim.
- **The Analyze workspace, and the workflow it completes** (#15). Generate hands Compare a
  deterministic reference set carrying the bound verifier, Compare records every text run as a
  registry run with a full `redrob-text-eval/v1` artifact, and **Analyze this run** deep-links to
  it. Analyze classifies wrong, partial and empty answers beside provider errors, shows
  Expected/Asked/Got, and compares models on pass rate with the statistics above.
- **Ranking, elimination and re-voting on the preference ballot** (#9). A group ballot can record
  a full order or knock answers out one at a time, and a prompt can be voted again: the log stays
  append-only and records the change of mind as an undo entry. Model identities now stay hidden
  until every prompt is decided, because naming one prompt's winner would name the model on the
  next.
- **Multi-turn evaluation** (#9). Scripted scenarios so every model hears the same words, each
  turn declaring the capability it tests. Tool turns ride the same JSON contract as the
  single-turn routing harness, so a small self-hosted model and a hosted API sit the same exam. A
  turn expecting a result for a call that never happened is marked desynced.
- **Whole-host deploy actions** (#9). Install lays down the unit and serve wrapper for every slot,
  so adding a slot later is a measurement rather than another install. Measure downloads weights
  for all slots in parallel, where the wall time goes, then sizes each slot alone because two
  probes would each claim the VRAM the other is about to take. Health checks are genuinely
  parallel; benchmark stays sequential, because concurrent generation on one card measures
  contention rather than throughput.

### Changed

- **The tool-routing set is 324 tasks, up from 100** (#9), 81 balanced per language, with absence
  cases up from 20 to 52 so BLOCK and DEFER are each measurable rather than single digit. A
  validator enforces the property that makes a task answerable at all: any argument the schema
  marks copied verbatim must appear in the request. It found a real defect on its first run, a
  Korean task expecting `Gangnam Station` where the request said 강남역. `yarn tool-routing:live`
  runs the set against real models, samples subsets by stride rather than taking a prefix, and
  prints every denominator.
- **Compare's image comparison is hidden**, not removed (#15). `COMPARE_IMAGE_UI_ENABLED` is
  false, so there is no modality decision before the text benchmark. Suites, judges, adapters and
  tournament support remain in place behind the switch.
- **Compare scores generated references with the bound verifier** (#15) rather than a generic
  string metric, so `13.8000` passes against reference `13.8` at tolerance `1e-4`. A flat gold
  value is kept beside it for readers.
- **Generate no longer needs an editable Python install** to work in the browser (#15): it prefers
  `redrob-generate` or `REDROB_GENERATE_CMD`, then falls back to loading `packages/generate/src`
  through `python3`.

### Fixed

- **Optimize run ids could collide** (#16). Four random suffix characters agree about 1% of the
  time across a burst of 200, which is two runs sharing a directory, one entry in the jobs map and
  one event stream. The suffix now counts from a random start, so a burst inside one process is
  collision-free outright.
- **`yarn runs` truncated run ids** so they could not be copied, and crashed with `EPIPE` when
  piped to `head` (#12).
- **A failed weight prefetch reported success** alongside its own warning, because every parallel
  job wrote to one log (#9).
- **A half-eliminated ballot recorded a winner as beating an answer already out** (#9). Both the
  ballot and a model judge now see only what is still standing.
- **`CONTRIBUTING.md` stated the branching model, the squash rule and the release QA layers
  twice** (#16), from a merge that kept both sides of rewritten prose.
