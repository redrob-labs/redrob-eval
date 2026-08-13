# Failure analysis

An accuracy column tells you how often a model was wrong. It never tells you
*how*, and "how" is the only thing that changes what you do next:

- A model that picks the right tool and formats it wrong needs a **prompt or
  parser** change.
- A model that picks the wrong tool needs better **tool descriptions**.
- A model that acts when it should have declined needs **something else again**.

All three are the same number in an accuracy column. This is the layer that
separates them.

## What a run has to keep

`summary` on a [registry](registry.md) run is for the handful of numbers a
listing shows. The evidence behind them — every prompt, reply and score — goes in
an **artifact**:

```ts
await store.putArtifact(runId, `cell-${cell.key}`, report);
```

Without this, a run can say 6% of replies failed to parse but never which ones,
and triage is guesswork. `yarn tool-routing:matrix` stores each cell's full
report, so its failures are analysable afterwards without re-calling anything.
Artifacts are also what a reproduction bundle will be made of.

Tool-routing reports now also record the **expected outcome** alongside each
reply. "Wrong arguments" is not a finding until you can see which ones were
wanted.

## The taxonomy

One shared set of kinds across harnesses, deliberately not one-per-harness —
`format` means the same thing whether it came from a routing task or the fourth
turn of a conversation.

| Kind | Meaning |
| --- | --- |
| `format` | The reply did not follow the required shape at all |
| `envelope` | The right decision through the wrong wrapper |
| `wrong_tool` | A tool was chosen, but not the right one |
| `bad_arguments` | Right tool, wrong arguments |
| `missed_abstention` | Should have declined; acted instead |
| `wrong_abstention` | Declined the wrong way (`BLOCK` where `DEFER` was owed) |
| `spurious_call` | Called a tool when the answer was already in the transcript |
| `instruction_dropped` | A constraint given earlier, never repeated, was dropped |
| `context_lost` | A fact the user stated earlier was not used |
| `correction_ignored` | A correction the user made was not applied |
| `desynced` | The script expected a tool result for a call never made |
| `call_error` | The provider call failed. Not the model's answer, not its fault |

**Classification order matters.** A reply that names the right tool inside the
wrong key is `envelope`, not bare `format`; calling it `format` would hide the
most actionable finding in the set — that the model can route and only the
wrapper is wrong. Multi-turn failures are classified by the capability the turn
declared, since the fixture already said what that turn was testing.

`RECOVERABLE_KINDS` (`format`, `envelope`, `desynced`) are the ones a prompt or
parser change could plausibly clear. Worth separating because that is work you
can do this afternoon, as opposed to needing a better model.

## Triage

```bash
yarn failures --run 2026-08-13_025745_tool-routing-matrix
yarn failures --run <id> --kind envelope,format
yarn failures --run <id> --model granite-4.1-8b --language ko
yarn failures --run <id> --show 3        # prompt, expectation and reply, side by side
yarn failures --run <id> --json out.json
```

A real run of two 3B models over twelve English tasks:

```
13 failure(s) across 2 artifact(s)

| kind              | count | share |
| format            | 6     | 46%   |
| envelope          | 4     | 31%   |
| bad_arguments     | 1     | 8%    |
| missed_abstention | 1     | 8%    |
| wrong_abstention  | 1     | 8%    |

10 of 13 are wrapper or protocol failures - a prompt or parser change, not a better model.
```

And what `--show` gives you, which is the part that actually ends an argument:

```
missed_abstention  ministral-3b-2512  en-block-chitchat (en)
why       called translate_text where it should have declined
expected  {"action":"BLOCK"}
asked     ... I could use a laugh before the standup starts. Tell me a joke about cats ...
got       {"tool":"translate_text","arguments":{"text":"Why don't cats play poker ...","target_language":"en"}}
```

It invented a joke and then called a translation tool on it. No rate would have
told you that.

The request is shown **without the tool catalogue** — a contract prompt is the
same page of JSON schemas on every task, and printing it buries the one line
that differs.

## Not done yet

- **No cohorts.** Saving a filtered set of failures and re-running just those
  cells is the obvious next step, and composes directly with the
  [job queue](job-queue.md): a cohort is a cell list.
- **No manual tagging.** The taxonomy is derived, not annotated. A researcher
  disagreeing with a classification currently has nowhere to record that.
- **No web workspace.** This is a CLI. The side-by-side view wants a screen.

## Related

- [Experiment registry](registry.md) — where artifacts live
- [Resumable job queue](job-queue.md) — how a cohort would be re-run
- [Tool routing](tool-routing.md) — what the failure kinds mean for that task
