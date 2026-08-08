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

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "all $CONTROLS negative controls detected their break"
  exit 0
fi
echo "$FAILURES of $CONTROLS negative controls did NOT detect their break"
exit 1
