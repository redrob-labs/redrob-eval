# 0002. Unicode semantics for the Generate module

Status: **open**. Two entries below record a residual that cannot be closed from inside this
repository, and say so.
Supersedes: the regex and comparison entries of `0001-generate-foundation.md`.
Superseded by: nothing.
Applies to: `spec/verifiable-task-v1.md`, `spec/verifiable-task-v1.schema.json`,
`spec/conformance/`, `packages/generate/src/redrob_generate/verify/`,
`packages/harness/src/generate/`.

This record exists because two defects reached a green build. Both were Unicode premise errors,
and both survived because **two independent implementations agreed on them**. Parity between two
implementations is the main evidence this project produces, and these are the cases where it is
worth nothing: when both sides share a wrong assumption, or when the corpus cannot reach the input
where they differ.

So the whole Unicode surface was audited rather than the two reported defects patched. Every
entry below states what was measured, on what, and what the measurement leaves unresolved.

---

## 1. `(?![\u0000-\uffff])` diverges on astral input, and the construct is gone

**Measured, not assumed.** Pattern `^foo(?![\u0000-\uffff])` against `foo😀`:

| Runtime | Result | Why |
| --- | --- | --- |
| Python `re` | **matches** | A string is code points. U+1F600 is outside U+0000..U+FFFF, so the negative lookahead succeeds. |
| JavaScript `RegExp`, no `u` | **does not match** | A string is UTF-16 code units. The lead surrogate U+D83D is inside the range, so the lookahead fails. |

Both engines are correct about their own model of a string. The construct was this spec's spelling
for "end of input" in a JSON Schema `pattern`, where there is no `mode` field to carry the intent,
so it appeared in the corpus and in a template. Nothing caught it because the corpus contained no
character outside the Basic Multilingual Plane: Devanagari and Hangul are both BMP, which is why
"the suite covers Unicode" was true and useless.

**Options.** (a) Keep the lookahead and add the `u` flag on the JavaScript side, making both
engines code-point-based. (b) Invent a third spelling. (c) Remove anchoring from the pattern
language and express it through the existing `mode` field.

**Chose (c), and (a) as well.** They are not alternatives. The `u` flag is now mandatory —
without it the engines disagree about what an atom is, and that would resurface somewhere else —
but a flag that makes one construct portable is not a reason to keep a construct whose meaning was
never obvious. `^` and `$` are banned from the standalone `regex` verifier, and `full_match`
versus `search` says the same thing in a field where a reader will look for it.

**Cost.** Any template that used `^` must be rewritten. Three corpus rows became
`invalid_pattern` rows. `mode: search` with a start anchor has no direct replacement and must be
written as a full-match pattern with an explicit tail, which is longer.

## 1a. `$` survives inside a JSON Schema `pattern`, and is one token, not a rewriter

`^...$` is how everyone writes an anchored JSON Schema `pattern` and there is no `mode` field
there to move the intent into. A subset that forbade it would be ignored, so the two anchors are
permitted in `pattern` and `patternProperties` only, and `$` is defined normatively as the
absolute end of input. A JavaScript `RegExp` without `m` already means that. Python's `$` also
matches before one trailing newline, so the Python implementation substitutes `\Z` for that one
token.

**This is not the general pattern rewriter that decision 0001 removed, and the difference is not
a matter of degree.** That rewriter had to model each engine's reading of `.`, `^`, `$`, `\s` and
the flag set; it was a second implementation of regex semantics and would have needed its own
conformance suite to be trusted. This is one fixed token replaced by one fixed token, in one
dialect, in a function short enough to read in a sitting
(`regex_subset.to_python_source`). The corpus row
`json_schema/pattern-dollar-excludes-a-trailing-newline` fails the moment it stops happening, and
`json_schema/pattern-dollar-excludes-a-trailing-astral` is the A1 defect kept as a regression
row.

**Unresolved.** The asymmetry — `$` legal in one dialect and not the other — is a wart. It is
justified by usage rather than by principle, and a reviewer may prefer consistency at the cost of
readability. Reversing it means banning `$` in `pattern` too and requiring every schema author to
spell the anchor some other way.

---

## 2. Comparison declared no normalisation form, and now defaults to NFC

`exact`, `set_equality`, `ordered_equality` and JSON Schema string comparison compared strings
with no normalisation. Hangul `가` is U+AC00 precomposed and U+1100 U+1161 as conjoining jamo;
they render identically and compared unequal. Devanagari nukta forms and Latin combining accents
have the same property.

**Chose:** a `normalization` field on every comparison verifier, values `NFC`, `NFD`, `NFKC`,
`NFKD`, `none`, defaulting to **`NFC`**, applied to the candidate and to the expected value, and
to every string *and object key* inside a parsed JSON instance.

The default is the decision, not the field. `none` is the honest default in the sense that it
does nothing surprising, and it is the wrong one: a model whose tokeniser emits decomposed jamo
scores lower than a model that emits precomposed jamo for the same visible answer, and the
difference is invisible in every log and diff that will ever display it. `none` stays available
because byte exactness is sometimes the thing under test, and it has to be asked for.

### 2a. The schema is required to be normalised, not normalised for you

A `json_schema` verifier normalises the instance and **refuses a schema that is not already in
the declared form**. Rewriting the schema instead would have been more forgiving. It is wrong: a
`const` written in NFD under a verifier declaring NFC can never match anything, which is a bug in
the template rather than a property of any answer, and rewriting it makes the template mean
something its author did not write. `pattern` and `patternProperties` keys are exempt — they are
regex source, not text to be compared.

### 2b. What was measured, and the residual

Both runtimes' normalisation tables were read in full: all 1 112 064 code points, four forms,
compared entry by entry. `packages/generate/tests/test_unicode_parity.py` does this on every run
and `scripts/unicode-tables.mts` is the other half.

| Form | Code points where the two disagree | All unassigned in the older UCD? |
| --- | --- | --- |
| NFC | **0** | — |
| NFD | 20 (U+105C9..U+16D6A) | yes |
| NFKC | 36 (U+1CCD6..U+1CCF9) | yes |
| NFKD | 56 (U+105C9..U+1CCF9) | yes |

Measured with CPython 3.12.3 (`unicodedata` 15.0.0) against Node v22.14.0 (ICU 76.1, Unicode
16.0). There is **no code point that both sides consider assigned and map differently**; every
disagreement is a character one database has and the other does not.

**So NFC is safe and the other three carry a version dependency.** The test asserts NFC exactly,
with no allowance, and asserts for the other three that every disagreement is about a code point
this Python considers unassigned — a disagreement about an assigned character would be two
implementations reading the same standard differently and is a hard failure.

**Unresolved, and stated in the spec:** a template declaring `NFD`, `NFKC` or `NFKD` is
reproducible only across runtimes carrying the same Unicode version. Closing this means pinning
one Unicode version for both runtimes, which is a dependency decision — an ICU pin plus a CPython
pin, or a vendored UCD — and not one to take unattended.

---

## 3. Length had no unit, and `graphemes` is refused rather than approximated

`min_length` and `max_length` were "length", which is code points in Python and UTF-16 code units
in JavaScript. These differ for every astral character, and neither is what a person means:
`नमस्ते` is six code points, six UTF-16 units, eighteen UTF-8 bytes and four grapheme clusters.

**Chose:** a `length_unit` field with `codepoints` (default), `utf16`, `bytes_utf8` implemented,
and `graphemes` **specified and refused with an error**.

**Options for `graphemes`.** (a) `Intl.Segmenter` in TypeScript and a maintained grapheme library
in Python. (b) `Intl.Segmenter` and a hand-rolled approximation in Python. (c) Refuse it.

**Chose (c).** Option (b) is disqualified outright — an approximation of UAX #29 would be wrong
on exactly the emoji and conjunct sequences the unit exists for. Option (a) is the one that looks
right and is the reason this entry is long: the two implementations would be reading *different
Unicode versions*, as §2b measures, and grapheme breaking is defined against a specific version's
property tables. Two breakers over different tables produce two lengths, one of them silently
scores a model, and no test comparing the two implementations against a corpus written in either
version would see it. That is precisely the failure mode this whole audit exists to remove.

An error is the only answer that cannot be quietly wrong. Refusing a documented unit is worse
usability than approximating it and better epistemics, and this module's entire claim is
epistemic.

**Reverse by** pinning one Unicode version across both runtimes and then adding the two
implementations; the field name and the schema already exist.

**Cost.** A template that wants a human-meaningful length bound cannot have one. `codepoints` is
the closest available and over-counts every conjunct and every emoji sequence.

### 3a. `bytes_utf8` is computed from code points rather than from an encoder

`TextEncoder` substitutes U+FFFD for a lone surrogate and Python's `str.encode` refuses to encode
one. Both answers are three bytes, but arriving there by arithmetic over code points means the
two implementations agree by construction rather than by coincidence.

---

## 4. Unpaired surrogates in configuration are refused

Found by the A5 sweep below, not by a report, and reproduced as a failing corpus row before the
fix.

```
format_constraint, required_substrings: ["\ud83d"], candidate: "😀"
  Python      → missing_required_substring
  TypeScript  → ok
```

U+D83D is the lead unit of the pair encoding U+1F600. A JavaScript string is UTF-16 code units,
so the needle *is* the first half of the haystack and `includes` finds it; a Python string is code
points, so the needle is a character that is simply not there. The same split runs through
`String.prototype.split` against a lone-surrogate delimiter, which cuts an emoji in half on one
runtime and matches nothing on the other.

**Chose:** refuse any unpaired surrogate anywhere in a verifier's configuration, checked once at
dispatch rather than per verifier so that a field added later inherits the rule. There is no
reading of the input on which the two engines agree, so there is nothing to pin and the only
answers are "refuse" or "diverge".

**Candidates are deliberately exempt.** A candidate is model output and must always yield a
verdict rather than an error; and an unpaired surrogate in a candidate is harmless on its own,
because the divergence needs the needle rather than the haystack to be half a pair.

---

## 5. The corpus is now required to be able to see a divergence

A4 asked for astral, combining, ZWJ and mixed-script coverage. It is a test rather than a
convention, because the reason A1 was invisible was that a corpus of Devanagari and Hangul is
entirely BMP and every case agreed on both sides while the subset was broken.

Row counts, cases plus rejections, before and after this pass:

| File | Before | After |
| --- | --- | --- |
| `exact` | 27 | 39 |
| `numeric_tolerance` | 37 | 42 |
| `json_schema` | 58 | 72 + 1 rejection |
| `regex` | 75 | 98 |
| `set_equality` | 34 | 44 + 1 rejection |
| `ordered_equality` | 26 | 34 |
| `format_constraint` | 36 | 59 + 2 rejections |
| `all_of` | 22 + 14 rejections | 28 + 14 rejections |
| **Total** | **329** | **434** |

---

## 6. A5 sweep: every string operation, with a verdict

Grepped for `len(`, `.length`, `charAt`, `charCodeAt`, indexing, `slice`, `substring`, and case
mapping in both implementations. Sites operating on lists and on ASCII-only intermediates are
grouped; every site touching arbitrary text is listed.

| Site | Operation | Verdict |
| --- | --- | --- |
| `base.py:code_point_length` / `text.ts:codePointLength` | `len(text)` / `for..of` count | **Safe.** Python's `len` is code points by definition; the TypeScript side iterates code points rather than using `.length`, which would count UTF-16 units. |
| `text.ts:measureLength` `utf16` branch | `text.length` | **Safe and intentional.** This branch *is* the UTF-16 count; Python computes it arithmetically from code points and the two are compared by conformance rows. |
| `base.py:utf8_byte_length` / `text.ts:utf8ByteLength` | per-code-point arithmetic | **Safe.** Deliberately not an encoder; see §3a. |
| `base.py:strip_spec_whitespace` / `text.ts:stripSpecWhitespace` | `str.strip` / code-unit index walk | **Safe.** Every character in the spec whitespace set is BMP and not a surrogate, so the walk can never stop inside a pair and the resulting `slice` can never split one. |
| `base.py:collapse_spec_whitespace` / `text.ts:collapseSpecWhitespace` | regex sub / `for..of` | **Safe.** The TypeScript side iterates code points; the Python regex class is the explicit spec set. |
| `base.py:count_lines` / `text.ts:countLines` | `split('\n')` | **Safe.** `\n` is ASCII and cannot occur inside a multi-unit sequence. |
| `text.ts:compareByCodePoint` | spread to code points, then compare | **Safe, and load-bearing.** `Array.prototype.sort`'s default compares UTF-16 units and would order canonical JSON keys differently from Python's `sorted`. |
| `json-schema-subset.ts:436` | `codePointLength` for `minLength`/`maxLength` | **Safe.** Draft 2020-12 defines these in code points; `.length` here would be a silent divergence from `jsonschema`. |
| `regex_subset.py` / `regex-subset.ts` scanners | index walk over the pattern | **Safe by explicit compensation.** Python steps by code point and TypeScript by code unit, so the TypeScript scanner reassembles well-formed surrogate pairs into one token and rejects unpaired ones. The verdict dumps now carry each pattern's full token stream, so a regression in that reassembly shows up as a token diff — including the case where it changes no verdict. |
| `declarative.py` / `verifiers.ts` substring checks | `in` / `String.includes` | **Safe only after §4.** Both are code-unit or code-point containment over well-formed input, which agree; the unpaired-surrogate needle was the one case where they did not, and it is now refused. |
| `declarative.py:_split_elements` / `verifiers.ts:splitElements` | `split(delimiter)` | **Safe only after §4**, for the same reason. |
| `text.ts` / `base.py` normalisation | `normalize` / `unicodedata.normalize` | **Safe for NFC, version-dependent otherwise.** See §2b. |
| `declarative.py` `.lower()` / `verifiers.ts` `.toLowerCase()` | default case mapping | **Locale-independent, and version-dependent.** See §6a. |
| `expr.py:lower/upper/title` | derivation-language builtins | **Python only.** No TypeScript peer exists to diverge from; these run at generation time and their output is hashed into the template content hash, so a Python upgrade that changes them changes the hash visibly. |
| `render.py:42`, `executable.py:35`, `canonical.py:69-77`, `fertility.py:59` | index walks and `len` | **Python only** (generation, execution, number formatting, fertility). `canonical.py` operates on the ASCII digit string from `repr(float)`. `fertility.py`'s `characters` metric is code points and is reported, not compared. |
| Remaining `len(` / `.length` sites | lists, dicts, arrays, token vectors, ASCII hex runs | **Not text.** No Unicode exposure. |

### 6a. Case mapping is locale-independent, and that had to be checked too

`case_sensitive: false` routes through `str.lower()` and `String.prototype.toLowerCase()`. Both
are the **locale-independent** Unicode default mapping; neither `str.casefold()` nor
`toLocaleLowerCase()` is used anywhere, and the spec now says so. The Turkish dotless i is the
standard trap: `İ` (U+0130) lowercases to `i` under a `tr` locale and to `i` + U+0307 under the
root locale, and both implementations were confirmed to produce the two-code-point form.
U+0131 dotless i is left unchanged by both.

The full lowercase table was compared the same way as the normalisation tables:

- 27 code points where the two disagree, **all unassigned** in `unicodedata` 15.0.0
  (U+1C89, U+A7CB, U+A7CC, U+A7DA, U+A7DC, and the Garay block U+10D50..U+10D65).
- **0** code points that both consider assigned and map differently.

So `case_sensitive: false` carries the same version dependency as `NFD`/`NFKC`/`NFKD`, bounded to
characters one runtime does not know exist, and none of them in this benchmark's target scripts.

**Unresolved.** The regex `i` flag was removed because no configuration of the two engines agrees
on case folding, and leaving `case_sensitive: false` in place is arguably inconsistent with that.
The difference is that the regex divergence was about characters both engines know
(`re.IGNORECASE` folds U+0131 to `i` and a `RegExp` with `iu` does not), whereas this one is a
version skew only. A reviewer who wants strict consistency should remove
`case_sensitive: false` from `exact`, `format_constraint` and the `case_insensitive_string`
comparator; the cost is that "Answer" and "answer" become different answers.

---

## 7. Field naming: `length_unit`, not `lengthUnit`

The task specifies `lengthUnit`. Every other field in this spec is `snake_case`, including
`normalize_line_endings`, `case_sensitive` and `element_comparator`, and the JSON is read by both
a Python and a TypeScript implementation. **Chose `length_unit`** for consistency; a single
camelCase field would be a permanent oddity in the schema. Likewise `normalization` rather than
the existing `unicode_normalization`, which was renamed because the field is no longer only about
Unicode composition and the shorter name matches the other verifiers.

**Reverse by** renaming in the schema, both implementations and the corpus; nothing outside this
module reads either name.
