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
run set is the commercially usable rows — Qwen3, Qwen3.5, Qwen2.5 (the
Apache-licensed sizes), Granite 4.0, SmolLM2, LFM2.5, Midm. The non-commercial
rows — Hammer2.1 and the xLAM function-calling specialists — are `eval_only`
and never in the default set or the deploy catalog.

## Running it

```bash
yarn verify:tool-routing          # offline: integrity, balance, parse/score
yarn tool-routing:fertility       # tokens-per-word per model (tokenizer only)
```

Live evaluation runs through Compare (modality **Tool routing**) against
selected models, or a self-hosted served id via `/api/tool-routing/run`.

## Related

- [Multi-turn](multi-turn.md) — the same tool contract carried across a conversation
- [Preference](preference.md) — how the tool answers become a blind ranking
