# Templates

Task families for `redrob-generate`, conforming to
[Redrob Verifiable Task Spec v2](../spec/verifiable-task-v2.md).

## Layout

```
templates/<family>/<name>/
  template.json      locale-neutral core: id, version, family, parameters, derivations, verifier
  locales/en.json    locale layer: locale, description, prompt, optional notes
```

The loader merges the core with one locale layer and validates the result. A locale layer may
set `locale`, `description`, `prompt` and `notes`, and nothing else. Attempting to redeclare
parameters, derivations, the id, the version or the verifier is a load error.

That restriction is the entire point of the split. **A translation changes the wording, never the
task.** Two locales of one template id sample the same parameters from the same seed and expect
the same answer, which is what makes their token counts comparable in the sense of spec §8; if a
translation could change the parameters, the comparison would silently become meaningless.

## What is here

| Template | Family | Verifier |
| --- | --- | --- |
| `math/linear-equation` | math | `numeric_tolerance` |
| `extraction/quarterly-ledger` | extraction | [ `json_schema`, `exact` ] |
| `format/release-note` | format | [ `format_constraint`, `format_constraint` ] |

All three are `locale: en`. A bracketed verifier is the list form: every element runs and all
must pass, and the verdict names which element failed. `format/release-note` uses two
`format_constraint` elements rather than one because `case_sensitive` applies to every substring
check in a single constraint at once, and that template needs an exactly-cased header alongside a
banned word caught in any casing.

## Non-English templates

**There are none yet, and adding one is not a translation task.**

A locale layer must be reviewed by a native speaker before it is used for anything anyone will
cite. A machine-translated prompt measures the translation as much as it measures the model, and
in a fertility comparison — where the whole claim is that only the surface wording differs — a
bad translation invalidates the measurement outright rather than merely adding noise.

Concretely, a new locale layer needs a reviewer to confirm that:

- the instruction means the same thing, including what "reply with nothing else" implies
- the register matches the English, since formality changes token counts
- any format instruction is still checkable, e.g. a decimal separator that the verifier's number
  grammar accepts
- numerals, quoting and punctuation follow the locale's convention rather than English's

Until a layer has that review, it does not belong in this directory.

## Adding a template

1. Create `templates/<family>/<name>/template.json` with the locale-neutral core.
2. Create `templates/<family>/<name>/locales/en.json` with the prompt.
3. Emit a few instances and read them: `redrob-generate emit --template templates/<family>/<name> --count 5 --out /tmp/check`
4. Check that a correct answer passes and that near-miss answers fail with the code you expect.
   A verifier that accepts a near miss is worse than no verifier at all.
