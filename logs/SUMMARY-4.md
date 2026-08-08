# Summary 4: completing Generate for the language-cost study

Branch `feat/generate-study`, off `develop`. Two commits.

The goal was one command that turns a study config into a validated, reproducible results
artifact. That command exists:

```console
$ redrob-generate study --config packages/generate/examples/language-cost-mock.study.json --out /tmp/study
```

It generates instances per template per locale from content-derived seeds, asks each model under
test, scores every answer with the Python verifiers, counts tokens under a named scheme, and
writes `result.json` and `aggregates.txt`. Against the mock provider it reaches no network and
costs nothing.

---

## 1. Step 1 was already done, and doing it as written would have been wrong

The task opens with "squash merge `refactor/verifier-list` into `main`". That branch was merged
into `develop` in the previous session and deleted, and PR #2 was closed. More importantly, the
gitflow model adopted in `docs/decisions/0004` reserves `main` for releases, so merging a feature
branch there now would undo a decision taken two sessions ago.

So: nothing was merged, `main` was not touched, and work happened on `feat/generate-study` off
`develop`, which is where the verifier-list work already lives. Everything downstream of step 1
was done as written.

## 2. What was built

**Verdict provenance and the Python-normative policy.** Every verdict record carries the
implementation that produced it, that implementation's version and the version of the Unicode
table it read. Python marks its verdicts authoritative; TypeScript marks its own
non-authoritative, and `localProvenance` takes no argument that changes that. Publishable
artifacts refuse to build from a non-authoritative verdict, and a *missing* provenance block
counts as non-authoritative — absence has to fail closed, because unknown origin is exactly the
case to refuse.

The policy has a measurable justification rather than a stylistic one. On this machine the two
runtimes report different Unicode tables, and the artifact records both so a reader can check:

```
runtime: redrob-generate 0.1.0   unicode 15.0.0  [authoritative]
runtime: @redrob/harness 22.14.0 unicode 16.0    [display only]
```

Two sentences went into `spec/verifiable-task-v2.md` §0. The spec was not restructured.

**Locale layer.** The loader already resolved a template id plus a locale and already refused a
locale layer that tried to change the task. Added: `translation_status` on every locale layer,
required with no default, and `hi`, `hi-Latn` and `ko` stubs for all three templates holding the
English prompt verbatim and marked `untranslated`. A missing locale was already a clear error
naming the locales that do exist.

The `locale` pattern gained a script subtag. Hinglish is `hi-Latn`, and the old pattern
(`^[a-z]{2,3}(-[A-Z]{2})?$`) rejected it outright, so the study could not have been expressed.

**Two new fields.** `fertility_tokenizer` on a study config, recorded per instance and in the
artifact. `code_mix_ratio` on every instance, required and always `null`.

**Study runner, results artifact, publication gates, CLI table.** Detailed in
`packages/generate/STUDY.md`.

## 3. Definition of done

Every command below was run. Full output is in `logs/NN-*.log`, written by
`bash scripts/verify-generate-dod.sh`, which passes all 16 steps.

| # | Item | Evidence |
| --- | --- | --- |
| 1 | PR #2 merged, `main` green | **Deviated.** Already merged to `develop`; see §1 |
| 2 | `study` runs end to end against the mock, no network | `logs/12`, plus a socket-guard test |
| 3 | Two runs, byte-identical output | `logs/12`: "byte-identical across 96 instance rows" |
| 4 | Artifact validates against its schema | `logs/13`: "validates against spec/study-v1.schema.json" |
| 5 | All three paired deltas present | `logs/13`, three rows, 24 pairs each |
| 6 | Publication refuses `untranslated`, proven by test | `logs/14`, control 12 |
| 7 | Publication refuses TypeScript verdicts, proven by test | `logs/14`, control 13 |
| 8 | Verdict records carry implementation, version, Unicode table | `logs/13`: all 96 rows |
| 9 | Existing suites pass, zero conformance divergence | `logs/06` 797 passed, `logs/04` 665 passed, `logs/10` |
| 10 | `tsc --noEmit` clean, build works without Python on PATH | `logs/02`, `logs/03`, `logs/01` |
| 11 | A negative control per new invariance claim | `logs/16`: "all 17 negative controls detected their break" |

Selected output:

```
=== 10-zero-divergence
TypeScript verdicts: 553 cases
Python verdicts:     553 cases
zero divergence

=== 13-study-artifact-shape
validates against spec/study-v1.schema.json
  english-vs-korean     24 pairs  tokens +0.000  accuracy +0.000
  korean-vs-hindi       24 pairs  tokens +0.000  accuracy +0.000
  hindi-vs-hinglish     24 pairs  tokens +0.000  accuracy +0.000
all 96 verdict rows carry implementation, version and unicode table

=== 14-study-publication-gates
refused untranslated locales (exit 3)
6 passed, 29 deselected

=== 15-build-output-unchanged
two builds of the same tree agree on 709 artifacts
identical across 709 artifacts
```

Six negative controls are new, one per new claim: stub-locale drift, the untranslated gate, the
foreign-verdict gate, verdict provenance, paired-delta pairing, and study determinism.

## 4. Read this row carefully

**Every paired delta in the shipped example is exactly `0.000`, and that is the correct answer.**

The three non-English locales render the English prompt byte for byte. There is nothing for a
tokenizer to find, so the example run measures English four times. The deltas are present, the
pairing is real (24 matched pairs each), and the arithmetic is exercised by unit tests built on
fabricated rows with non-zero differences — because a delta test whose expected answer is zero
cannot distinguish a working subtraction from a function that returns a constant.

A non-zero delta in that table would mean a stub had been edited and drifted from its source. A
test asserts byte-identity for exactly that reason, and negative control 11 confirms the test
fires when one space is added to the Korean stub.

## 5. Decisions taken without review

All five are in `docs/decisions/0005-study-runner.md`. In short:

1. **`code_mix_ratio` stays null.** Producing a number requires choosing a token unit, a language
   identifier, and a treatment of proper nouns and numerals; each choice changes the answer for
   the same sentence, and "Delhi" in a Hinglish sentence is not evidence of English.
2. **English source text is `single-reviewer`, not `native-reviewed`.** It is the source, not a
   translation, and the enum has no value for that. `native-reviewed` would assert a review that
   did not happen. A fourth enum value was rejected as scope.
3. **Stub locales are byte-identical copies**, never machine translations. Machine translation
   would produce text that looks like a translation, scores like one, and is not one.
4. **The bundled tokenizers are proxies, not model tokenizers.** See §6.
5. **The study schema is a separate document** (`spec/study-v1.schema.json`), so redesigning an
   experiment does not force a version bump of a spec meant to be citable.

Naming: the task said `translationStatus`, `fertilityTokenizer`, `codeMixRatio`; these are
implemented in `snake_case` to match every other field in these documents, as was done with
`length_unit` last pass.

## 6. Deviations and their cost

**Step 1 was skipped.** Cost: none. The content is on `develop`; `main` is untouched.

**The tokenizers are proxies.** This is the real one. A study run needs a token count per
instance, and the definition of done requires the whole path to run with no network. A model's
own tokenizer means downloading its vocabulary. Those two requirements do not both hold, so what
ships is three offline schemes — `builtin/utf8-bytes`, `builtin/codepoints`,
`builtin/whitespace-words` — named so none can be mistaken for a model's tokenizer and recorded
in the artifact.

The cost is that the pipeline is complete and the measurement is not. `utf8-bytes` moves in the
same direction as real fertility (Devanagari and Hangul cost three bytes per code point against
ASCII's one) but is not equal to it. `@redrob/tokenizers` already loads real tokenizers through
`AutoTokenizer`, so the missing piece is a bridge about the size of the model bridge; it was not
built because it cannot be exercised under the no-network requirement.

**The mock cannot invert three verifier types.** `regex`, `json_schema` and `format_constraint`
describe a set of acceptable answers rather than naming one. The mock answers wrongly against
them, visibly. `templates/format/release-note` is entirely `format_constraint`, so it is not in
the example config; the two templates that are exercise both a bare verifier and a list.

**The example set was regenerated.** Templates now carry `translation_status`, which changes the
template content hash, which changes `spec/conformance/example-set`. Expected, and caught by the
existing hash-parity test rather than found by hand.

## 7. Things I wanted to fix and left alone

The point of the task, so this is the honest list.

**In the code I touched:**

- `packages/generate/examples/language-cost-mock.study.json` reaches its templates through
  `../../../templates/...`. A `templates://` scheme or a repo-root anchor would be cleaner. Left
  alone: new config surface for a cosmetic gain.
- The mock's `alternating` strategy hashes `(model, template, index)` but not the locale, so a
  model gets the same items right in every locale. That is *deliberate* — it keeps the accuracy
  delta at zero unless something is wrong — but it means the accuracy-delta path only ever sees
  zero in the shipped example, and only the unit tests exercise a non-zero one.
- `verifier_family` is a string built by joining type names (`"[json_schema, exact]"`). A
  structured field would be better to group on. Left alone: it would widen the artifact schema
  for something no reader has asked for.
- The study runs strictly sequentially, like Compare. Fine for a mock, slow against real
  providers. Concurrency would need a decision about rate limits that belongs with whoever holds
  the keys.
- `peer_runtime_record()` shells out to `node` to read its Unicode version, so an artifact
  differs between a machine with node and one without. `--no-peer-probe` exists for that, and CI
  uses it. A cleaner design would record the peer version at build time.

**In code I read and did not touch:**

- `packages/harness/src/lib/eval/run.ts` calls `callModel` with `temperature: 0` and no seed. No
  provider is deterministic under that alone, and nothing records the non-determinism. The study
  artifact inherits the problem the moment a `harness` model is used, and does not currently say
  so. That deserves a field, and a field is a spec change.
- `resolveModel` consults a 6-hour OpenRouter disk cache, so the same model id can resolve
  differently on two days. Provenance-relevant and unrecorded.
- `SelfHostedMeta` has `precision` but no serving-engine or hardware field; those live in env
  vars on the GPU host (`MEASURED_*`). The study config accepts all three as free-text strings
  precisely because the catalog cannot supply them yet. Wiring them together is the obvious next
  step and would have meant touching Deploy.
- `measureFertility` in `packages/tokenizers` silently falls back to `length / 4` when a
  tokenizer fails to load, flagged only by `measured: false`. Any caller that ignores the flag
  gets a fabricated number. I wanted to make that fallback loud. It is used by Evolve, which is
  out of scope.

**Unicode.** No further audit passes were run, per the instruction. Nothing blocked this task,
so nothing was fixed. The nine unverified assumptions listed in `SUMMARY-3.md` §4 are still
unverified. One of them is now *load-bearing in a new way*: the Python/Node UCD version gap
(15.0.0 against 16.0) that motivates the normative-implementation policy is the same gap those
assumptions are about, and the policy manages the risk rather than removing it.

**Also not done, deliberately:** no property-based fuzzing, no mutation testing, no new verifier
types, no registry or DOI work, no docs site, no model API calls, no non-English template
content, no new model client, and no UI beyond the CLI table.
