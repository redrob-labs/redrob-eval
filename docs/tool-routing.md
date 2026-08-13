# Tool-routing dataset

The tool-routing task asks a sub-10B model to read a request and a set of tool
schemas and emit exactly one decision: a JSON tool call with arguments, or an
absence (`BLOCK` when nothing fits, `DEFER` when a required argument is
missing). It is scored on three axes — did it pick the right tool, did it get
the arguments exactly right, and did it decline when it should — plus a parse
failure rate for output that did not follow the contract.

## Scale and balance

The fixture set is at `packages/harness/src/lib/tool-routing/fixtures/tool-tasks.json`.

- **324 tasks**, balanced at **81 per language** across `en`, `hi`, `hi-Latn`
  (romanized Hindi) and `ko`. Balance is enforced by `yarn verify:tool-routing`:
  a per-language slice with a different N is not a fair comparison.
- **272 calls, 52 absences** (24 `BLOCK`, 28 `DEFER`). Absence is the capability
  small models fail on most and the one that most needs a denominator larger
  than single digits.
- Three **toolsets** offered per task: `core` (6 tools), `wide` (18), `full`
  (48). A task is offered its whole toolset and only one tool is correct, so a
  `full` task is 47 near-neighbour distractors and one answer. The wider sets
  exist because with six tools a model can be right by elimination, which
  flatters it.

The same scenario appears in all four languages with the arguments held
constant, so a per-language difference is a difference in the model's
cross-lingual routing, not in the task.

## Ground-truth integrity

The score that a fixture can silently corrupt is `argExactMatch`: if the
expected arguments name a value the request never gave, no model can produce it,
and the task quietly caps every model's argument accuracy for a reason that is
the fixture's fault. So the dataset holds one invariant, checked in CI:

> Every argument the tool schema marks as copied **verbatim** (its description
> says "verbatim from the request" or "exactly as written") must appear in the
> request text. Everything else — a city normalized to English, a date to ISO,
> a language code — is not required to appear, because it is transformed, not
> copied.

`validateToolRoutingTasks` (in `validate.ts`) enforces this, along with: the
expected tool is actually in the toolset the task is offered, the argument keys
match the schema exactly (nothing missing, nothing extra), languages are known,
and absence actions are `BLOCK` or `DEFER`. It runs in `yarn verify:tool-routing`
and as a unit test. It found a real bug on its first run: a Korean task whose
request said `강남역` expected the English `"Gangnam Station"`, which no model
could have extracted.

This is why the arguments are mostly language-neutral tokens — order ids, ISO
dates, tracking numbers, tickers, amounts, English city names — even when the
request is in Hindi or Korean. That is realistic (tool arguments are usually
canonical) and it keeps the ground truth verifiable in every language. Where an
argument is genuinely free text (an email subject, a note body, a search
query), the exact string is embedded verbatim in the request, so the copy is
always recoverable.

## Models

`models.ts` is the sub-10B registry, all with a recorded licence. The default
run set is the commercially usable rows — Qwen3, Qwen3.5 (to 9B), Qwen2.5 (the
Apache-licensed sizes), Granite 4.0 **and 4.1**, Gemma 4 E2B/E4B, SmolLM2,
LFM2.5, Midm. The non-commercial rows — Hammer2.1 and the xLAM function-calling
specialists — are `eval_only` and never in the default set or the deploy
catalog. Granite 4.1's 30B and the larger Qwen3.5 sizes are deliberately absent:
this registry is for what fits under 10B.

## Running it

```bash
yarn verify:tool-routing          # offline: integrity, balance, parse/score
yarn tool-routing:fertility       # tokens-per-word per model (tokenizer only)
yarn tool-routing:live --models liquid/lfm-2.5-2.6b:free,ibm-granite/granite-4.1-8b
yarn tool-routing:live --models qwen/qwen3.5-9b --languages en,ko --limit 30 --json out.json
```

`tool-routing:live` runs the set against real models and prints an overall table
plus a per-language one. Live evaluation also runs through Compare (modality
**Tool routing**), or against a self-hosted served id via `/api/tool-routing/run`.

## What the failures actually are

Running the current sub-10B field turned up something worth stating before
anyone reads an accuracy column: **for the smallest models, format compliance
fails far more often than routing does.** LFM2.5-2.6B picked the right tool with
the right arguments on every reply that parsed, and half its replies did not
parse — it puts the tool name in `action`, the key the contract reserves for
`BLOCK` and `DEFER`. Llama-3.2-3B does the same thing on about three quarters of
replies. A report that collapses that into one accuracy number says these models
cannot route, and they can.

So the report separates them. A reply that names the right tool through the
wrong wrapper is still scored strictly as a parse failure — the contract asked
for one shape and got another — but it is also counted as an `envelope` error,
with the tool it meant recorded. Two models with the same parse failure rate and
very different envelope counts are failing at different things.

Two observed output styles are the harness's problem rather than the model's,
and both are now handled:

- **Commented JSON.** Ministral 3B/8B answer with a fenced block annotated the
  way a person writes one (`"amount": 0, // missing, cannot proceed`). That is
  not JSON, so it threw, and the model was recorded as unparseable when it had
  in fact chosen a tool and invented a placeholder argument. Comments and
  trailing commas are now stripped **after** strict parsing has already failed,
  so a well-formed reply never takes that path. The failures moved out of
  "unparseable" and into the absence column, where they belong: the real mistake
  was making a call instead of deferring.
- **Flattened arguments.** Granite 4.0 H Micro emits
  `{"action":"lookup_contact","name":"…"}` — tool name in `action` *and*
  arguments spread across the top level. Still a parse failure; now recorded
  with the call it meant, so it reads as the wrapper mistake it is.

The general rule: strictness decides the score, diagnostics decide what the
score means. Loosening the first would flatter the models; leaving out the
second invites the wrong conclusion about them.

## A recorded run

Full English set (81 tasks), contract condition, through OpenRouter, 2026-08-12.
Denominators in brackets: each metric is taken only over the examples it applies
to, so absence is over the absence tasks and arguments over the calls that
parsed.

| model | tool select | args exact | absence | parse fail | envelope |
| --- | --- | --- | --- | --- | --- |
| qwen/qwen3.5-9b | 100% (68) | 100% (68) | 100% (13) | 0% | 0 |
| ibm-granite/granite-4.1-8b | 99% (67) | 97% (67) | 50% (10) | 5% | 2 |
| mistralai/ministral-8b-2512 | 99% (68) | 90% (68) | 31% (13) | 0% | 0 |
| ibm-granite/granite-4.0-h-micro | 98% (63) | 97% (63) | 38% (13) | 6% | 5 |
| qwen/qwen-2.5-7b-instruct | 97% (67) | 96% (67) | 31% (13) | 1% | 1 |
| google/gemma-3-4b-it | 94% (68) | 94% (68) | 23% (13) | 0% | 0 |
| liquid/lfm-2.5-2.6b | 89% (19) | 89% (19) | 100% (11) | 63% | 10 |
| meta-llama/llama-3.2-3b-instruct | 81% (16) | 81% (16) | 86% (7) | 72% | 29 |

Three things this set is for, and what it showed:

1. **Picking the tool is close to solved; knowing when not to call is not.**
   Six of the eight models select the right tool 94-100% of the time, and then
   range from 23% to 100% on absence. Absence is the axis that still separates
   this field, which is why it is 52 of the 324 tasks rather than the 20 it was.
2. **Format compliance is a separate failure, and it dominates for the smallest
   models.** LFM2.5-2.6B and Llama-3.2-3B fail the contract on 63% and 72% of
   replies, with 10 and 29 of those being the tool name in `action` — routing
   they got right, through a wrapper they got wrong. Their tool-select columns
   are over 19 and 16 examples for that reason, and should not be read beside a
   column over 68.
3. **Granite 4.1 over 4.0 shows up where IBM said it would.** Absence 38% → 50%
   and parse failures 6% → 5% on the same tasks, with the 4.1 8B also cutting
   envelope errors from 5 to 2.

A four-language smoke test (stride-free prefix sampling, so not citable as a
result) suggested tool selection holds across en/hi/hi-Latn/ko for the 8B-class
models while LFM2.5-2.6B drops to 89% Hindi and 86% Korean against 100% English.
Worth a full-set run before it goes in a paper.

## Reading the numbers

Each metric skips the examples it does not apply to — absence accuracy is over
the absence tasks only, argument accuracy over the calls that parsed — so
`tool-routing:live` prints the denominator next to every rate. Averaging rates
across slices without them silently assumes equal denominators.

`--limit N` samples by **even stride**, not by prefix. The fixture file is
ordered by scenario, so the first N tasks of a language are its first few
scenarios rather than a sample of it, and the absence cases are not spread
evenly through them. An early prefix run of 30 English tasks computed its
absence rate over five items, which is the small-denominator problem the
enlarged set exists to escape. Cite full-set runs; use `--limit` for smoke
tests.

## Related

- [Multi-turn](multi-turn.md) — the same tool contract carried across a conversation
- [Preference](preference.md) — how the tool answers become a blind ranking
