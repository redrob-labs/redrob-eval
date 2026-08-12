# Multi-turn evaluation

Every other harness here asks a model one question. That measures whether it can
answer, and says nothing about the thing conversations actually break on:
whether the constraint from turn one still holds at turn four, whether a
correction stuck, and whether a tool result two turns back gets used instead of
fetched again.

## The shape of a test

A scenario is a **scripted conversation**. The user's side is fixed, so every
model hears the same words in the same order and a difference in the transcript
is a difference in the model. No model can steer the dialogue, which is the
property that makes the runs comparable at all — and the honest limitation:
this is not a measure of how a model handles a conversation it is shaping.

```jsonc
{
  "id": "mt-en-suffix",
  "language": "en",
  "kind": "text",
  "turns": [
    { "user": "…end every reply with DONE…", "capability": "instruction_retention",
      "expect": [{ "kind": "contains", "text": "DONE" }] },
    { "user": "What is the capital of France?", "capability": "instruction_retention",
      "expect": [{ "kind": "contains", "text": "Paris" }, { "kind": "contains", "text": "DONE" }] }
  ]
}
```

Each turn declares one **capability**, because "68% of turns passed" does not
say whether the failures were forgotten instructions or bungled tool calls:

| Capability | What the turn is for |
| --- | --- |
| `instruction_retention` | An instruction given once, never repeated, still owed. |
| `context_recall` | A fact the user stated earlier, needed now. |
| `correction` | A detail the user took back. The old value must not win. |
| `tool_call` | The right call, with the right arguments, at the right turn. |
| `tool_use_result` | Answering from the result already in the transcript. |
| `tool_absence` | Declining rather than inventing, when nothing on offer fits. |

Checks are `contains`, `absent`, `regex`, `tool_call`, `absence` and
`no_tool_call`. Text comparison is case-insensitive and collapses whitespace: a
model that writes "Thursday, 3 PM" has not forgotten the day, and a check that
fails it is measuring formatting. Anything that has to be exact is a regex.

## How tools are carried

Tools are described in the prompt and calls come back as one JSON object — the
same contract as the [single-turn tool-routing harness](../README.md), reusing
the same tool catalog so the two scores are readable against each other. A tool
result is fed back as a user turn framed `TOOL RESULT for <tool>: {…}`.

The alternative was the provider-native `tools` / `tool_calls` fields, and the
reason those are not used is the reason the contract exists: they are not
available everywhere. A small model behind vLLM, a hosted API, and a local
served alias all have to be able to sit the same exam. What that costs is worth
stating plainly: **this measures whether a model can follow a tool protocol
described in text, not whether it drives a provider's function-calling API.**

Tool results are canned, never executed. A harness that called a real weather
service would be measuring that service too, and could not be replayed.

## When the model and the script come apart

A turn that expects a tool result has to follow a call the model actually made.
When it does not, the turn is marked `desynced`: the canned result is delivered
anyway so the rest of the conversation still runs, but that turn cannot pass,
because from there on the model is reading a transcript it did not produce.

Everything else is the model's own output, verbatim. A model that answered badly
at turn two is reading its own bad answer at turn three — which is the situation
being measured.

## What comes out

```
scenarios 6/7 (86%) · turns 19/21 (90%) · call errors 0 · p50 428 ms

| capability     | turns | pass |     | turn depth | turns | pass |
| tool_call      | 4     | 75%  |     | 1          | 7     | 86%  |
| tool_use_result| 2     | 50%  |     | 4          | 1     | 100% |
```

The depth cut is the one this harness exists for: a model that holds at turn one
and drops at turn four is a different problem from one that never held.

## Running it

```bash
yarn verify:multi-turn                                    # offline, scripted model side
yarn multi-turn:live --provider openrouter --model openai/gpt-4o-mini
yarn multi-turn:live --provider vllm --model redrob-s0 --languages ko
yarn multi-turn:live --model … --scenario mt-ko-weather --json
```

`verify:multi-turn` scripts the model side, so it proves the harness — the loop,
the scoring, the desync handling — with no keys and no network. It runs in CI.
`multi-turn:live` needs the provider key in the repo-root `.env`, and its output
is about the model rather than the harness.

## Fixtures

`packages/harness/src/lib/multi-turn/fixtures/scenarios.json`, in English and
Korean. Korean is not a translation of the English set: two of its scenarios
turn on things only Korean surfaces, such as an instruction to answer in Korean
being tested by an English question two turns later.

## Not done yet

- **No Compare stage.** This runs from the CLI. Wiring it into Compare would
  make transcripts votable in the preference stage, which is where a
  conversation ranking would come from — the checks answer "did it hold", not
  "which of these two conversations is better".
- **Native function calling** is not exercised, for the reason above.
- **No multi-turn routing labels.** Turn-level pass rates would need a defined
  mapping to `small` / `large` before they could feed routing.

## Related

- [Blind preference](preference.md) — where a human ranking would come from
- [Methodology](methodology.md) — routing labels, features, export
