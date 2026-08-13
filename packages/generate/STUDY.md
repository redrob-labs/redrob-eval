# Running a study

`redrob-generate study` takes one config and writes one results artifact. It generates instances
per template per locale, asks each model under test, scores every answer with the Python
verifiers, counts tokens, and aggregates.

```
redrob-generate study --config <path> --out <dir>
```

**Stub locales exist so this pipeline can be tested. They cannot be published.** `hi`, `hi-Latn`
and `ko` currently contain the English prompt copied verbatim and are marked `untranslated`. A run
over them completes and produces a full table of numbers, and every per-locale number in it is a
measurement of English. Passing `--publish` makes the command refuse rather than write such an
artifact.

---

## The config

```jsonc
{
  "study_version": "redrob-study/v1",
  "id": "language-cost-mock",

  // Seeds derive from the generator version, so the config records which one it was
  // designed against. Running under a different one is refused: the seeds would change,
  // so the items would not be the items this config describes.
  "seed_policy": { "method": "content-derived", "generator_version": "0.1.0" },

  // Name and version of the token counting scheme. Recorded per instance and in the
  // artifact. See "Tokenizers" below -- none of the bundled ones is a model's tokenizer.
  "fertility_tokenizer": { "name": "builtin/utf8-bytes", "version": "1" },

  // Template family directories, resolved relative to this file rather than to the
  // working directory, so a config is portable.
  "templates": [
    { "path": "../../../templates/math/linear-equation", "count": 8 },
    { "path": "../../../templates/extraction/quarterly-ledger", "count": 4 }
  ],

  // The 2x2. Both levels are labels the author assigns, not measurements the runner
  // makes: calling Korean high-fertility is the hypothesis under test, so the runner
  // records the label and never derives it.
  "locales": [
    { "tag": "en", "fertility_level": "low", "resource_level": "high" },
    { "tag": "ko", "fertility_level": "high", "resource_level": "high" },
    { "tag": "hi", "fertility_level": "high", "resource_level": "low" },
    { "tag": "hi-Latn", "fertility_level": "low", "resource_level": "low" }
  ],

  "models": [
    { "id": "mock/always-right", "provider": "mock", "mock_strategy": "expected" },
    { "id": "mock/sometimes-right", "provider": "mock", "mock_strategy": "alternating" }
  ],

  // Paired comparisons. Every one must name two declared locales.
  "comparisons": [
    { "id": "english-vs-korean", "left": "en", "right": "ko" },
    { "id": "korean-vs-hindi", "left": "ko", "right": "hi" },
    { "id": "hindi-vs-hinglish", "left": "hi", "right": "hi-Latn" }
  ]
}
```

Validated against `spec/study-v1.schema.json` before anything runs.

### Models

| `provider` | What it does | Network |
| --- | --- | --- |
| `mock` | Answers in process from the instance itself | none |
| `harness` | Shells out to the harness's `callModel`, the same path Compare uses | yes |

A `harness` model's `id` is the canonical `provider/model` id that Compare resolves, for example
`openai/gpt-4o-mini` or `vllm/redrob-s`. There is no second model client here: the bridge at
`scripts/study-model-call.mts` is about sixty lines and every decision it could make (resolving
the id, picking the adapter, retrying, reading keys) is `resolveModel` and `callModel` making it.

`quantization`, `serving_engine` and `hardware` are optional and recorded verbatim where known.
`null` means unknown; it does not mean "none", so an unquantised model should say `bf16`.

### The mock provider

`mock_strategy` is required. There is no default, because every default is a silent assumption
about how good the imaginary model is.

| Strategy | Behaviour |
| --- | --- |
| `expected` | Synthesises an answer the verifier should accept |
| `wrong` | Always answers `MOCK-INCORRECT-ANSWER` |
| `alternating` | Alternates, keyed on a hash of model, template and index |

The mock inverts only the verifiers whose config literally contains the answer: `exact`,
`numeric_tolerance`, `set_equality`, `ordered_equality`, and lists containing one of those.
`regex`, `json_schema` and `format_constraint` describe a *set* of acceptable answers rather than
naming one, and constructing a member is a search problem the mock does not attempt, so against
those it answers wrongly, visibly, in the artifact. `templates/format/release-note` is entirely
`format_constraint`, so a mock study over it scores zero by construction.

A synthesised answer is never assumed to pass. The runner scores it with the real verifier, the
same way it scores a real model's answer. If the mock's guess were trusted, a broken verifier
would report 100% accuracy and look like a working study.

### Tokenizers

| Name | Counts | Note |
| --- | --- | --- |
| `builtin/utf8-bytes` | UTF-8 bytes | Closest of the three to real fertility |
| `builtin/codepoints` | Code points | Moves the *wrong* way for Hangul |
| `builtin/whitespace-words` | Whitespace-separated words | Poor for scripts that do not space |

**None of these is a model's tokenizer.** A real fertility measurement needs the vocabulary of the
model under test, which means a download, and a study has to be runnable and testable offline.
The scheme in use is recorded per instance and in the artifact, so no number here can be mistaken
for one measured under a model's own tokenizer. See `docs/decisions/0005-study-runner.md` §4.

---

## A worked example

Ships at `packages/generate/examples/language-cost-mock.study.json`. Needs no keys, no network and
no spend.

```console
$ redrob-generate study \
    --config packages/generate/examples/language-cost-mock.study.json \
    --out /tmp/study
study: language-cost-mock  (redrob-study/v1)
tokenizer: builtin/utf8-bytes 1
runtime: redrob-generate 0.1.0  unicode 15.0.0  [authoritative]
runtime: @redrob/harness 22.14.0  unicode 16.0  [display only]

locales
tag      fertility  resource  translation
-------  ---------  --------  ---------------
en       low        high      single-reviewer
ko       high       high      untranslated
hi       high       low       untranslated
hi-Latn  low        low       untranslated

accuracy per locale per verifier family
model                 locale   verifier family       n  passed  accuracy
--------------------  -------  --------------------  -  ------  --------
mock/always-right     en       [json_schema, exact]  4       4     1.000
mock/always-right     en       numeric_tolerance     8       8     1.000
...
mock/sometimes-right  ko       numeric_tolerance     8       5     0.625

mean prompt tokens per locale
locale    n  mean tokens
-------  --  -----------
en       12      301.417
hi       12      301.417
hi-Latn  12      301.417
ko       12      301.417

paired deltas (right minus left, matched on template and instance)
comparison         left  right    pairs  tok left  tok right  tok delta  acc delta
-----------------  ----  -------  -----  --------  ---------  ---------  ---------
english-vs-korean  en    ko          24   301.417    301.417      0.000      0.000
korean-vs-hindi    ko    hi          24   301.417    301.417      0.000      0.000
hindi-vs-hinglish  hi    hi-Latn     24   301.417    301.417      0.000      0.000

NOT PUBLISHABLE: ko, hi, hi-Latn render placeholder text, so their per-locale
numbers measure the placeholder.
```

**Every delta is exactly zero, and that is the correct answer.** The three non-English locales
render the English prompt byte for byte, so there is nothing for the tokenizer to find. A non-zero
delta in this table would mean a stub had been edited and had drifted from its source. A test
asserts the stubs are byte-identical for that reason.

Two files land in `--out`:

- `result.json` - the artifact, validated against `spec/study-v1.schema.json`
- `aggregates.txt` - the table above

Reruns are byte-identical apart from `created_at`; pass `--created-at` to pin that too.

```console
$ redrob-generate study --config <cfg> --out /tmp/a --created-at 2026-01-01T00:00:00Z --quiet
$ redrob-generate study --config <cfg> --out /tmp/b --created-at 2026-01-01T00:00:00Z --quiet
$ diff -r /tmp/a /tmp/b && echo identical
identical
```

---

## From the workbench

`/generate` in the web UI covers the same ground without the command line.

**Templates** lists every family under `templates/`, each locale it has, and how reviewed that
locale is. Picking one samples a few instances and shows the rendered prompt, the parameters that
produced it, and the verifier that will score it. Selecting a locale marked `untranslated` says so
before showing you a prompt that is going to be in English.

**Study** runs a shipped config and renders the aggregate tables, along with the provenance block
(both runtimes and the Unicode version each reads) and the publication verdict.

Both stages hand their output onward. Templates offers the sampled set as a download, the prompts
on the clipboard, the `emit` command that reproduces the same sampling on disk, and a hand-off that
opens Compare with the prompts loaded as a custom set. Exact and numeric-tolerance verifiers carry a
single deterministic reference, so those sets are scored automatically with their bound verifier;
format-only verifiers describe many valid answers and remain unscored rather than inventing one gold
string. Study
offers the result artifact and the rendered table. Neither writes into the repository, so those
downloads are the only copy; `redrob-generate study --out` is the way to keep one on disk.

Three things the page does deliberately:

- **It always asks the publication gate.** The CLI writes the artifact before checking it, so
  asking is free, and reporting "publishable" without having checked would be the page asserting
  something it never established. The refusal shown is Python's own, not a second implementation of
  the rule living in the browser.
- **It will not spend money.** A config declaring a `harness` model is refused by the route, not
  merely hidden in the UI. Real model calls stay on the command line, where the spend is a decision
  someone typed.
- **It says when it cannot help.** Sampling is Python-only. This repository's TypeScript
  implementation reads and verifies but does not generate, so without the CLI on `PATH` the page
  says exactly that and still lists the catalog, which is read from disk.

---

## The artifact

Numbers only. There is no field for a conclusion and no code that writes one.

- **`provenance`** - generator and spec versions, seed policy, tokenizer, both runtimes with the
  Unicode version each actually reads, every model with its quantization / serving engine /
  hardware where known, and the timestamp.
- **`locales`** - the 2×2 labels plus the `translation_status` found on disk, so a reader sees
  which locales were placeholders without opening the templates.
- **`instances`** - one row per (model, locale, template, index): seed, verdict, per-element
  verdicts where the verifier field held a list, prompt token count, `code_mix_ratio`, and the
  provenance of that verdict.
- **`aggregates.accuracy`** - pass rate per model per locale per verifier family.
- **`aggregates.tokens`** - mean prompt tokens per locale, counting each prompt once however many
  models saw it.
- **`aggregates.paired_deltas`** - one row per declared comparison.

### Why paired

Seeds carry no locale term, so instance 3 of a template is *the same item* in every locale: same
parameters, same expected answer, only the wording differs. Deltas are therefore computed over
items matched on `(template, instance)` and averaged, rather than as a difference between two
independent means. An item present in one locale and missing from the other is dropped and counted
in `dropped_unpaired` rather than filled in, so the two sides of a delta are always the same items.

### Publication

`--publish` makes the command exit non-zero rather than leave a publishable-looking artifact that
is not. Two refusals:

1. **Any locale is `untranslated`.** Its prompts are placeholders, so its numbers measure the
   placeholder.
2. **Any verdict was not produced by `redrob-generate`.** Python is normative; the TypeScript
   implementation marks its own verdicts non-authoritative in the record. Not because it is less
   correct (it passes the same conformance corpus) but because the two runtimes compile against
   different Unicode tables, which the header above shows directly: 15.0.0 against 16.0.

Both are checked against the written artifact rather than trusted from the run that produced it,
so an artifact that arrived from somewhere else is checked the same way.
