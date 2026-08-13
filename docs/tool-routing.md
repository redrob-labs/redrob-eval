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
