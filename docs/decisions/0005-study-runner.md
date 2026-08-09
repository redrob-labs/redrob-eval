# 0005. The study runner, and five decisions taken without review

Status: **provisional**. Every choice below was made by an unattended agent that could not ask a
question. Each is reversible, and the ones that are more than mechanical say what would change
them.
Supersedes: nothing.
Superseded by: nothing.
Applies to: `packages/generate/src/redrob_generate/study/`, `spec/study-v1.schema.json`,
`spec/verifiable-task-v2.md` §0, §1.2, §1.3, `templates/*/*/locales/`.

`redrob-generate study --config <path> --out <dir>` runs one study: it generates instances per
template per locale from content-derived seeds, asks each model under test, scores with the
Python verifiers, counts tokens, and writes one results artifact plus a plain-text aggregate
table. The design question it exists to answer is what a language costs — across English, Korean,
Hindi and Hinglish, arranged as a 2×2 of fertility level against resource level.

The single property everything else rests on is in the seed derivation, which was already there:
a seed is a function of the generator version, the template id and the instance index, and
**carries no locale term**. So instance 3 of a template is the same item in all four locales, with
the same parameters and the same expected answer, differing only in wording. That is what makes a
*paired* comparison legitimate, and it is why the aggregates pair on `(template, instance)` rather
than comparing two independent samples.

---

## 1. `code_mix_ratio` is null, and stays null

The field is required on every instance and no code computes it.

A code-mix ratio is the proportion of a Hinglish prompt drawn from English rather than Hindi. To
produce a number you must first choose three things, and each choice changes the answer for the
same sentence: the unit being counted (characters, whitespace words, morphemes, subword tokens —
and if subword tokens, whose), the language identifier that labels each unit, and the treatment of
the material that belongs to neither language cleanly (proper nouns, digits, product names,
punctuation, borrowings so old they are no longer felt as borrowings). "Delhi" in a Hinglish
sentence is not evidence of English. Neither is "2024".

Publishing a ratio computed from unstated choices would be worse than publishing nothing, because
a number invites comparison with other people's numbers computed from different choices. So the
field is present and null. It is present rather than absent so that the artifact shape does not
change when the method is settled, and null rather than omitted so a reader can tell "not
measured" from "produced by an older tool".

**What would change this:** a written method, reviewed by someone who speaks the language.

## 2. English source text is `single-reviewer`, not `native-reviewed`

`translation_status` has three values and English fits none of them: it is the source, not a
translation.

`native-reviewed` was rejected because it would assert a review that did not happen. `single-
reviewer` is the honest reading — one person wrote the text and nobody else checked it — and it
has the right consequence, since it is publishable while `untranslated` is not. Adding a fourth
value such as `source` was rejected as scope: the task fixed the enum at three.

The cost is that a reader cannot distinguish "source text" from "translated once, unchecked" by
reading the field. That is a real loss of information and the right place to fix it is the enum.

## 3. Stub locales are the English text byte for byte

`hi`, `hi-Latn` and `ko` exist for all three templates, marked `untranslated`, containing the
English prompt verbatim.

The alternative — leaving the locales absent until translations exist — would have meant the
pipeline could not be run or tested across locales at all, and the first real translation would
land on untested machinery. The alternative in the other direction, machine translation, was
rejected outright: it would produce text that looks like a translation, scores like one, and is
not one, and the resulting numbers would be indistinguishable from real ones.

A test asserts that each stub is byte-identical to its English source, and it is load-bearing.
A hand-edit to a stub — one respaced line — would make the per-locale token counts diverge, and
that divergence would look exactly like a finding about the language. The shipped example
consequently reports a token delta of exactly `0.000` in all three comparisons. That is the
correct answer for placeholder text and it is worth stating plainly: **the example run measures
English four times.**

## 4. The bundled tokenizers are proxies, not model tokenizers

A study run needs a token count per instance, and the study has to be runnable and testable with
no network. A model's own tokenizer means downloading its vocabulary. Those two requirements do
not both hold, so what ships is three offline schemes — `builtin/utf8-bytes`,
`builtin/codepoints`, `builtin/whitespace-words` — named so that none can be mistaken for a
model's tokenizer, and recorded per instance and in the artifact.

`utf8-bytes` is the least misleading: Devanagari and Hangul code points cost three UTF-8 bytes
against ASCII's one, and subword vocabularies are generally built over byte sequences, so it moves
in the same direction as real fertility. `codepoints` moves in the *opposite* direction for
Hangul, which packs a syllable into one code point, and it is included so that the gap between a
plausible proxy and a misleading one is visible rather than theoretical.

**This is the largest gap between what the command does and what the study wants.** A real
fertility measurement needs the tokenizer of the model under test. `@redrob/tokenizers` already
loads those through `AutoTokenizer`, so the missing piece is a bridge of about the same size as
the model bridge — but it cannot be exercised under the no-network requirement that this task's
definition of done imposes, so it was not built.

## 5. The study schema is a separate document

`spec/study-v1.schema.json`, not an addition to `spec/verifiable-task-v2.schema.json`.

The task spec describes an item and how it is scored, and is meant to be stable and citable. A
study config describes one particular experiment and is expected to change as the experiment
does. Merging them would mean redesigning the experiment forces a spec version bump, and every
consumer of the spec would have to care.

The two new fields the task did name — `translation_status` and `code_mix_ratio` — went into the
task schema, because they describe a template and an instance rather than an experiment.

---

## Naming

The task named the fields `translationStatus`, `fertilityTokenizer` and `codeMixRatio`. They are
implemented as `translation_status`, `fertility_tokenizer` and `code_mix_ratio`, matching the
`snake_case` every other field in these documents already uses, and matching what was done with
`length_unit` in the previous pass. A single camelCase field among a hundred snake_case ones would
be a permanent papercut for every reader.

The branch is `feat/generate-study`, as the task specified. `CONTRIBUTING.md` lists `feature/`;
`feat/` is now noted there as an accepted short form rather than silently diverging.

## Outstanding

- The measurement method for `code_mix_ratio` (§1) — needs a human decision.
- A fourth `translation_status` value for source text (§2) — needs the enum reopened.
- A tokenizer bridge to `@redrob/tokenizers` (§4) — needs a decision about whether a study run
  may reach the network to fetch a vocabulary.
- Real translations for `hi`, `hi-Latn` and `ko` (§3) — needs native-speaker review, and is
  permanently out of scope for an agent.
