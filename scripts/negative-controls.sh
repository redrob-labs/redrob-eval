#!/usr/bin/env bash
# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
#
# Break each invariant on purpose and show that the check for it fails.
#
# Every "the two implementations agree" claim in this module rests on a comparison, and a
# comparison only counts as evidence if a difference would have been noticed. This script
# introduces one difference per claim, runs the check that is supposed to catch it, and
# asserts that it does. A control that *passes* here is the failure: it means the check it
# guards cannot fail and is therefore not evidence of anything.
#
# Every edit is made to a copy of the file, applied, and reverted in a trap, so an
# interrupted run leaves the tree clean. Nothing here is committed.
#
# Usage: bash scripts/negative-controls.sh

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.local/bin:$PATH"

BACKUP="$(mktemp -d)"
FAILURES=0
CONTROLS=0

restore() {
  local relative
  while IFS= read -r relative; do
    [ -n "$relative" ] || continue
    cp "$BACKUP/$(echo "$relative" | tr '/' '_')" "$ROOT/$relative"
  done <"$BACKUP/manifest"
  : >"$BACKUP/manifest"
}
trap 'restore; rm -rf "$BACKUP"' EXIT
: >"$BACKUP/manifest"

# Save a file so the trap can put it back, then edit it in place with a Python snippet
# read from stdin. The snippet gets the path in argv[1].
#
# Returns non-zero if the edit did not change the file, which matters: a snippet whose
# anchor text has drifted would leave the tree intact, the check would pass, and the run
# would report a control that cannot fail. Callers turn that into a reported failure.
break_file() {
  local relative="$1"
  cp "$ROOT/$relative" "$BACKUP/$(echo "$relative" | tr '/' '_')"
  echo "$relative" >>"$BACKUP/manifest"
  python3 - "$ROOT/$relative" || {
    echo "the edit script failed, so the invariant was never broken" >&2
    return 1
  }
  if cmp -s "$ROOT/$relative" "$BACKUP/$(echo "$relative" | tr '/' '_')"; then
    echo "the edit left $relative unchanged, so the invariant was never broken" >&2
    return 1
  fi
}

# Run a command that is expected to FAIL, and report on it. The claim is the invariant; the
# break is what was done to violate it.
expect_failure() {
  local claim="$1" broke="$2"
  shift 2
  CONTROLS=$((CONTROLS + 1))
  echo
  echo "--- claim: $claim"
  echo "    break: $broke"
  local output status
  output="$("$@" 2>&1)"
  status=$?
  if [ $status -eq 0 ]; then
    echo "    CONTROL FAILED: the check passed with the invariant broken, so it is not"
    echo "                    evidence for the claim"
    FAILURES=$((FAILURES + 1))
  else
    echo "    detected (exit $status):"
    echo "$output" | grep -E 'AssertionError|assert|^[<>]|not ok|Error:|differs|differing|disagree' |
      head -6 | sed 's/^/      /'
  fi
  restore
}

# ---------------------------------------------------------------------------------------
# 1. The two implementations agree on every conformance case.
#
# Broken by removing the TypeScript regex scanner's surrogate-pair reassembly. Its index
# walks UTF-16 code units where Python's walks code points, and the reassembly is the whole
# of what compensates for that.

diverge_verdicts() {
  break_file packages/harness/src/generate/regex-subset.ts <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
text = path.read_text()
marker = "        character.charCodeAt(0) <= 0xdbff &&"
assert text.count(marker) == 2, text.count(marker)
index = text.index(marker)
path.write_text(text[:index] + "        false &&" + text[index + len(marker):])
PY
  [ $? -eq 0 ] || return 0
  npx tsx scripts/generate-verdicts.mts >/tmp/nc-ts.json 2>/dev/null
  python3 scripts/generate_verdicts.py >/tmp/nc-py.json
  diff /tmp/nc-py.json /tmp/nc-ts.json
}

expect_failure \
  "the two implementations produce the same verdict for every conformance case" \
  "removed the TypeScript regex scanner's surrogate-pair reassembly" \
  diverge_verdicts

# ---------------------------------------------------------------------------------------
# 2. The regex token streams agree, and catch drift the verdicts cannot see.
#
# Broken by mislabelling group tokens as literals. No candidate changes its verdict; the
# scanners have simply stopped describing the same pattern the same way. This is the case
# the token comparison exists for, and the verdict comparison is blind to it.

diverge_tokens_only() {
  break_file packages/harness/src/generate/regex-subset.ts <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
old = "tokens.push({ kind: 'group', text: pattern.slice(index, index + 3) });"
new = "tokens.push({ kind: 'literal', text: pattern.slice(index, index + 3) });"
text = path.read_text()
assert old in text
path.write_text(text.replace(old, new))
PY
  [ $? -eq 0 ] || return 0
  npx tsx scripts/generate-verdicts.mts >/tmp/nc-ts.json 2>/dev/null
  python3 scripts/generate_verdicts.py >/tmp/nc-py.json
  local verdict_rows token_rows
  verdict_rows=$(diff /tmp/nc-py.json /tmp/nc-ts.json | grep '^<' | grep -vc '"tokens:')
  token_rows=$(diff /tmp/nc-py.json /tmp/nc-ts.json | grep '^<' | grep -c '"tokens:')
  echo "verdict rows differing: $verdict_rows"
  echo "token rows differing:   $token_rows"
  [ "$verdict_rows" -eq 0 ] && [ "$token_rows" -gt 0 ] && return 1
  return 0
}

expect_failure \
  "the token stream comparison sees scanner drift that verdicts alone do not" \
  "mislabelled group tokens as literals in the TypeScript scanner" \
  diverge_tokens_only

# ---------------------------------------------------------------------------------------
# 3. NFC agrees between the two runtimes on every code point.
#
# Broken by perturbing one entry of the dumped table. The test's own control does this in
# memory; this one does it to the dump, which is the path the test actually reads.

diverge_nfc() {
  break_file scripts/unicode-tables.mts <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
old = "    const result = apply(character, operation);"
new = (
    "    let result = apply(character, operation);\n"
    "    if (operation === 'NFC' && codePoint === 0xc5) result = 'x';"
)
text = path.read_text()
assert old in text
path.write_text(text.replace(old, new))
PY
  [ $? -eq 0 ] || return 0
  python3 -m pytest packages/generate/tests/test_unicode_parity.py -q -k nfc_agrees 2>&1
}

expect_failure \
  "Python's unicodedata.normalize and String.prototype.normalize agree on NFC everywhere" \
  "changed one entry of the JavaScript NFC table in the dump" \
  diverge_nfc

# ---------------------------------------------------------------------------------------
# 4. The corpus can reach a Unicode divergence.
#
# Broken by dropping the astral, combining, ZWJ and mixed-script rows from one file, which
# is the state the corpus was in when the A1 defect was invisible.

shrink_corpus() {
  break_file spec/conformance/exact.json <<'PY'
import json, sys, unicodedata
from pathlib import Path
path = Path(sys.argv[1])
document = json.loads(path.read_text(encoding="utf-8"))

def interesting(case):
    text = json.dumps(case, ensure_ascii=False)
    return (
        any(ord(c) > 0xFFFF for c in text)
        or "\u200d" in text
        or any(unicodedata.category(c) in ("Mn", "Mc", "Me") for c in text)
        or any(0x0900 <= ord(c) <= 0x097F or 0xAC00 <= ord(c) <= 0xD7AF for c in text)
    )

document["cases"] = [case for case in document["cases"] if not interesting(case)]
path.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
PY
  [ $? -eq 0 ] || return 0
  python3 -m pytest packages/generate/tests/test_conformance.py -q \
    -k "unicode_divergence and exact" 2>&1
}

expect_failure \
  "every declarative verifier's case set contains input where the runtimes could differ" \
  "deleted every non-ASCII row from exact.json" \
  shrink_corpus

# ---------------------------------------------------------------------------------------
# 5. The hand-written TypeScript JSON Schema validator agrees with ajv.
#
# Broken by making maxLength count UTF-16 code units, which is the natural thing to write
# and is wrong for every astral character.

diverge_from_ajv() {
  break_file packages/harness/src/generate/json-schema-subset.ts <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
old = "    const length = codePointLength(value);"
new = "    const length = value.length;"
text = path.read_text()
assert old in text
path.write_text(text.replace(old, new))
PY
  [ $? -eq 0 ] || return 0
  node --import tsx --test scripts/test/generate-json-schema-oracle.test.mts 2>&1
}

expect_failure \
  "the hand-written subset validator agrees with ajv on every corpus schema" \
  "made maxLength count UTF-16 code units instead of code points" \
  diverge_from_ajv

# ---------------------------------------------------------------------------------------
# 6. The generated TypeScript types match the schema.

diverge_spec_types() {
  break_file packages/harness/src/generate/spec-types.generated.ts <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
text = path.read_text()
old = '"length_unit"?:'
assert old in text
path.write_text(text.replace(old, '"length_unit_typo"?:', 1))
PY
  [ $? -eq 0 ] || return 0
  yarn generate:spec-types:check 2>&1
}

expect_failure \
  "spec-types.generated.ts is what the schema generates" \
  "renamed one generated field" \
  diverge_spec_types

# ---------------------------------------------------------------------------------------
# 7. Generation is reproducible from the seed alone.
#
# Broken by perturbing the seed derivation. Two emits of the same template must stop being
# byte-identical, or the derivation is not what determines the output.

diverge_emit() {
  break_file packages/generate/src/redrob_generate/seed.py <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
text = path.read_text()
old = (
    "    digest = hashlib.sha256("
    "seed_message(generator_version, template_id, instance_index)).digest()"
)
assert old in text
# A process-dependent term in the seed, which reproducibility must notice.
new = (
    "    import os\n"
    "    digest = hashlib.sha256(\n"
    "        seed_message(generator_version, template_id, instance_index) + os.urandom(4)\n"
    "    ).digest()"
)
path.write_text(text.replace(old, new))
PY
  [ $? -eq 0 ] || return 0
  rm -rf /tmp/nc-emit-a /tmp/nc-emit-b
  python3 -m redrob_generate.cli emit --template templates/math/linear-equation --count 4 \
    --out /tmp/nc-emit-a --created-at 2026-01-01T00:00:00Z --citation-year 2026 --quiet
  python3 -m redrob_generate.cli emit --template templates/math/linear-equation --count 4 \
    --out /tmp/nc-emit-b --created-at 2026-01-01T00:00:00Z --citation-year 2026 --quiet
  diff -r /tmp/nc-emit-a /tmp/nc-emit-b
}

expect_failure \
  "two emits of the same template are byte-identical" \
  "added a random term to the seed derivation" \
  diverge_emit

# ---------------------------------------------------------------------------------------
# 8. The per-element report of a verifier list agrees across implementations.
#
# Broken by making the TypeScript side stop at the first failing element, which is what the
# combinator this replaced did. No *case* changes its overall verdict, because the overall
# code is the first failure's either way; only the element report shrinks. So this is the
# control that says comparing `passed` and `code` alone would not have noticed.
#
# One rejection row does change its overall verdict:
# `rejects-executable-after-failing-declarative`, where a short-circuiting implementation
# never reaches the executable element and returns a mismatch instead of refusing. That is
# the row the eager pre-walk existed for, and it is checked separately below.

diverge_element_report() {
  break_file packages/harness/src/generate/registry.ts <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
text = path.read_text()
old = "    if (!verdict.passed && firstFailure === undefined) firstFailure = verdict;"
new = (
    "    if (!verdict.passed && firstFailure === undefined) {\n"
    "      firstFailure = verdict;\n"
    "      return true;\n"
    "    }\n"
    "    return false;"
)
assert old in text
# forEach ignores a return value, so the short circuit needs the loop to become one that
# honours it; `some` stops on a truthy return.
text = text.replace(old, new)
old_loop = "verifiers.forEach((element, index) => {"
assert old_loop in text
text = text.replace(old_loop, "verifiers.some((element, index) => {")
path.write_text(text)
PY
  [ $? -eq 0 ] || return 0
  npx tsx scripts/generate-verdicts.mts >/tmp/nc-ts.json 2>/dev/null
  python3 scripts/generate_verdicts.py >/tmp/nc-py.json
  # Rejection rows are excluded from the verdict count, because a short circuit genuinely
  # does change one of them, and that is a different claim.
  python3 -c "
import json, pathlib
document = json.loads(pathlib.Path('spec/conformance/verifier_list.json').read_text('utf-8'))
print('\n'.join(f'\"{row[\"id\"]}\":' for row in document.get('rejections', [])))
" >/tmp/nc-rejection-ids
  local differing case_rows element_rows rejection_rows
  differing=$(diff /tmp/nc-py.json /tmp/nc-ts.json | grep '^<')
  element_rows=$(printf '%s\n' "$differing" | grep -c '"elements:')
  rejection_rows=$(printf '%s\n' "$differing" | grep -cF -f /tmp/nc-rejection-ids)
  case_rows=$(printf '%s\n' "$differing" | grep -v '"elements:' | grep -vcF -f /tmp/nc-rejection-ids)
  echo "case verdict rows differing: $case_rows"
  echo "element rows differing:      $element_rows"
  echo "rejection rows differing:    $rejection_rows  (the eager-walk row, claim 8b below)"
  [ "$case_rows" -eq 0 ] && [ "$element_rows" -gt 0 ] && return 1
  return 0
}

expect_failure \
  "the element report comparison sees a short circuit that case verdicts do not" \
  "made the TypeScript verifier list stop at its first failing element" \
  diverge_element_report

# ---------------------------------------------------------------------------------------
# 8b. Running every element is what refuses an executable one behind a failure.
#
# The same break, checked against the corpus rejection row rather than the dump. `all_of`
# needed an eager pre-walk to make this hold; a list gets it from having no short circuit,
# and this control is what proves the two are equivalent rather than merely both green.

short_circuit_hides_an_executable_element() {
  break_file packages/harness/src/generate/registry.ts <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
text = path.read_text()
old = "    if (!verdict.passed && firstFailure === undefined) firstFailure = verdict;"
new = (
    "    if (!verdict.passed && firstFailure === undefined) {\n"
    "      firstFailure = verdict;\n"
    "      return true;\n"
    "    }\n"
    "    return false;"
)
assert old in text
text = text.replace(old, new)
old_loop = "verifiers.forEach((element, index) => {"
assert old_loop in text
text = text.replace(old_loop, "verifiers.some((element, index) => {")
path.write_text(text)
PY
  [ $? -eq 0 ] || return 0
  node --import tsx --test scripts/test/generate-conformance.test.mts 2>&1 |
    grep -A4 'not ok.*rejects-executable-after-failing-declarative' && return 1
  return 0
}

expect_failure \
  "an executable element behind a failing one is still refused" \
  "made the TypeScript verifier list stop at its first failing element" \
  short_circuit_hides_an_executable_element

# ---------------------------------------------------------------------------------------
# 9. The schema refuses an executable element of a verifier list, structurally.
#
# Broken by pointing the list's items at the full verifier union instead of the declarative
# one. Nothing at runtime changes — both dispatchers still refuse the configuration — so the
# only thing that notices is the schema-rejection corpus.

widen_verifier_list() {
  break_file spec/verifiable-task-v2.schema.json <<'PY'
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
document = json.loads(path.read_text(encoding="utf-8"))
document["$defs"]["verifier_list"]["items"] = {"$ref": "#/$defs/verifier"}
path.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
PY
  [ $? -eq 0 ] || return 0
  python3 -m pytest packages/generate/tests/test_conformance.py -q -k schema_rejection 2>&1
}

expect_failure \
  "an executable element of a verifier list is refused by schema validation" \
  "pointed the verifier list's items at the full verifier union" \
  widen_verifier_list

# ---------------------------------------------------------------------------------------
# 10. The schema-rejection rows are not satisfied by a schema that refuses everything.
#
# Broken by corrupting a valid_counterpart. Each row asserts both that the bad document is
# refused and that a near-identical good one is accepted; without the second half the row
# would pass for a schema with no content at all.

break_valid_counterpart() {
  break_file spec/conformance/verifier_list.json <<'PY'
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
document = json.loads(path.read_text(encoding="utf-8"))
row = document["schema_rejections"][0]
row["valid_counterpart"] = [{"type": "exact"}]  # missing the required `expected`
path.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
PY
  [ $? -eq 0 ] || return 0
  python3 -m pytest packages/generate/tests/test_conformance.py -q -k schema_rejection 2>&1
}

expect_failure \
  "a schema-rejection row also proves the schema accepts the valid counterpart" \
  "made one valid_counterpart invalid" \
  break_valid_counterpart

# ---------------------------------------------------------------------------------------
# 11. A stub locale is the English text byte for byte.
#
# Broken by respacing one line of a Korean stub. This is the control that matters most for
# the study, because the damage is invisible: the run still completes, the table still
# fills in, and the token delta it now reports looks exactly like a finding about Korean.

drift_a_stub_locale() {
  break_file templates/math/linear-equation/locales/ko.json <<'PY'
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
document = json.loads(path.read_text(encoding="utf-8"))
document["prompt"] = document["prompt"].replace("Solve the", "Solve  the", 1)
path.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
PY
  [ $? -eq 0 ] || return 0
  python3 -m pytest packages/generate/tests/test_study.py -q -k verbatim 2>&1
}

expect_failure \
  "a stub locale is the English prompt byte for byte, so its token counts are not a finding" \
  "added one space to the Korean stub of linear-equation" \
  drift_a_stub_locale

# ---------------------------------------------------------------------------------------
# 12. Publication refuses an untranslated locale.

allow_untranslated_publication() {
  break_file packages/generate/src/redrob_generate/study/publish.py <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
text = path.read_text()
marker = 'PUBLISHABLE_STATUSES = ("native-reviewed", "single-reviewer")'
assert marker in text, "anchor drifted"
path.write_text(text.replace(
    marker,
    'PUBLISHABLE_STATUSES = ("native-reviewed", "single-reviewer", "untranslated")',
))
PY
  [ $? -eq 0 ] || return 0
  python3 -m pytest packages/generate/tests/test_study.py -q -k untranslated 2>&1
}

expect_failure \
  "a publishable artifact refuses a locale whose prompt is placeholder text" \
  "added untranslated to the publishable statuses" \
  allow_untranslated_publication

# ---------------------------------------------------------------------------------------
# 13. Publication refuses a verdict this project's Python implementation did not produce.

allow_foreign_verdicts() {
  break_file packages/generate/src/redrob_generate/provenance.py <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
text = path.read_text()
marker = '    return provenance.get("authoritative") is True'
assert marker in text, "anchor drifted"
path.write_text(text.replace(marker, "    return True"))
PY
  [ $? -eq 0 ] || return 0
  python3 -m pytest packages/generate/tests/test_study.py -q -k "typescript_produced or no_provenance_at_all" 2>&1
}

expect_failure \
  "a publishable artifact refuses a verdict produced by the display implementation" \
  "made every provenance block count as authoritative" \
  allow_foreign_verdicts

# ---------------------------------------------------------------------------------------
# 14. Every verdict record carries the provenance of the implementation that produced it.
#
# Broken by dropping the field. The artifact schema requires it, so this also checks that
# the schema is load-bearing rather than decorative.

drop_verdict_provenance() {
  break_file packages/generate/src/redrob_generate/study/result.py <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
text = path.read_text()
marker = '            "verdict_provenance": dict(provenance),\n'
assert marker in text, "anchor drifted"
path.write_text(text.replace(marker, ""))
PY
  [ $? -eq 0 ] || return 0
  python3 -m pytest packages/generate/tests/test_study.py -q -k "own_verdict_provenance" 2>&1
}

expect_failure \
  "every verdict record names the implementation, version and Unicode table behind it" \
  "removed verdict_provenance from the instance rows" \
  drop_verdict_provenance

# ---------------------------------------------------------------------------------------
# 15. A paired delta compares the same items on both sides.
#
# Broken by pairing an unmatched item with itself instead of dropping it. Every count still
# looks plausible -- n_pairs even goes up -- and the delta is now computed over two
# different sets of items, which is the failure the pairing exists to prevent.

pair_unmatched_items_with_themselves() {
  break_file packages/generate/src/redrob_generate/study/result.py <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
text = path.read_text()
marker = "            if partner is None:\n                dropped += 1\n                continue\n"
assert marker in text, "anchor drifted"
path.write_text(text.replace(
    marker,
    "            if partner is None:\n                dropped += 1\n                partner = row\n",
))
PY
  [ $? -eq 0 ] || return 0
  python3 -m pytest packages/generate/tests/test_study.py -q -k "unpaired" 2>&1
}

expect_failure \
  "a paired delta drops an unmatched item rather than filling it in" \
  "paired every unmatched item with itself" \
  pair_unmatched_items_with_themselves

# ---------------------------------------------------------------------------------------
# 16. Two study runs with the same config produce byte-identical output.
#
# Broken by making the mock provider's choice random. Nothing errors; the artifact is still
# valid and the table still renders. Only the rerun comparison notices.

make_the_mock_nondeterministic() {
  break_file packages/generate/src/redrob_generate/study/models.py <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
text = path.read_text()
marker = "        return digest[0] % 2 == 0"
assert marker in text, "anchor drifted"
path.write_text(text.replace(
    marker,
    "        import random\n\n        return random.random() < 0.5",
))
PY
  [ $? -eq 0 ] || return 0
  python3 -m pytest packages/generate/tests/test_study.py -q -k "reruns_identically or is_deterministic" 2>&1
}

expect_failure \
  "two study runs with the same config produce byte-identical output" \
  "made the mock provider answer at random" \
  make_the_mock_nondeterministic

# ---------------------------------------------------------------------------------------
# 18. A locale nobody reviewed is never presented as reviewed.
#
# Broken by defaulting the catalog's translation status to native-reviewed when a layer
# does not declare one. This is the failure mode worth a control because it is silent and
# it is upward: the page shows a green chip, the reader believes a number is about Korean,
# and nothing in the run errors. Absence of a claim has to read as absence of review.

default_a_locale_to_reviewed() {
  break_file packages/harness/src/generate/catalog.ts <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
text = path.read_text()
marker = "(layer.translation_status as TranslationStatus) ?? 'untranslated',"
assert marker in text, "anchor drifted"
path.write_text(text.replace(
    marker,
    "(layer.translation_status as TranslationStatus) ?? 'native-reviewed',",
))
PY
  [ $? -eq 0 ] || return 0
  node --import tsx --test scripts/test/generate-catalog.test.mts 2>&1
}

expect_failure \
  "a locale layer that declares no review status is treated as unreviewed" \
  "defaulted the catalog's translation status to native-reviewed" \
  default_a_locale_to_reviewed

# ---------------------------------------------------------------------------------------

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "all $CONTROLS negative controls detected their break"
  exit 0
fi
echo "$FAILURES of $CONTROLS negative controls did NOT detect their break"
exit 1
