#!/usr/bin/env bash
# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
#
# Runs every definition-of-done check for the Generate module and writes each one's full
# stdout and stderr to logs/. Kept as a script rather than a list in a document so that
# the evidence in logs/SUMMARY.md can be regenerated instead of transcribed.
#
# Usage: bash scripts/verify-generate-dod.sh

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGS="$ROOT/logs"
mkdir -p "$LOGS"
cd "$ROOT"

export PATH="$HOME/.local/bin:$PATH"

FAILURES=0

step() {
  local name="$1"
  shift
  echo "=== $name"
  {
    echo "\$ $*"
    echo
  } >"$LOGS/$name.log"
  if "$@" >>"$LOGS/$name.log" 2>&1; then
    echo "    PASS  (logs/$name.log)"
  else
    local status=$?
    echo "    FAIL exit=$status  (logs/$name.log)"
    FAILURES=$((FAILURES + 1))
  fi
}

# 1. Install and build with no Python on PATH. Generation is optional and the existing
#    quickstart must be unaffected, so the build runs against a PATH with every python and
#    pip entry removed.
build_without_python() {
  local shim
  shim="$(mktemp -d)"
  local entry tool name
  IFS=':' read -ra ENTRIES <<<"$PATH"
  for entry in "${ENTRIES[@]}"; do
    [ -d "$entry" ] || continue
    for tool in "$entry"/*; do
      [ -e "$tool" ] || continue
      name="$(basename "$tool")"
      case "$name" in
        python | python2 | python3 | python3.* | pip | pip3 | pip3.*) continue ;;
      esac
      [ -e "$shim/$name" ] || ln -s "$tool" "$shim/$name" 2>/dev/null || true
    done
  done
  PATH="$shim" bash -c '
    set -e
    if command -v python3 >/dev/null 2>&1; then
      echo "python3 is still reachable; this check would prove nothing" >&2
      exit 1
    fi
    echo "python:  $(command -v python3 || echo "not found")"
    echo "python3: $(command -v python || echo "not found")"
    echo "pip:     $(command -v pip3 || echo "not found")"
    echo
    yarn install --frozen-lockfile
    yarn build
  '
  local status=$?
  rm -rf "$shim"
  return $status
}

# 2. emit twice, byte-identical including the manifest. --created-at makes the timestamp an
#    argument rather than a clock read, so nothing has to be excluded from the diff.
reproducible_emit() {
  local status=0 template name
  for template in templates/math/linear-equation templates/extraction/quarterly-ledger templates/format/release-note; do
    name="$(basename "$template")"
    rm -rf "/tmp/dod-a-$name" "/tmp/dod-b-$name"
    redrob-generate emit --template "$template" --count 8 --out "/tmp/dod-a-$name" \
      --created-at 2026-01-01T00:00:00Z --citation-year 2026 --quiet || status=1
    redrob-generate emit --template "$template" --count 8 --out "/tmp/dod-b-$name" \
      --created-at 2026-01-01T00:00:00Z --citation-year 2026 --quiet || status=1
    echo "--- $name"
    if diff -r "/tmp/dod-a-$name" "/tmp/dod-b-$name"; then
      echo "    identical: $(sha256sum "/tmp/dod-a-$name"/* | sed 's|/tmp/dod-a-'"$name"'/||')"
    else
      status=1
    fi
    rm -rf "/tmp/dod-a-$name" "/tmp/dod-b-$name"
  done

  # The same check without --created-at, with only the timestamp excluded, so that the
  # claim holds for the default invocation too.
  echo "--- default invocation, created_at excluded"
  rm -rf /tmp/dod-c /tmp/dod-d
  redrob-generate emit --template templates/math/linear-equation --count 8 --out /tmp/dod-c --quiet || status=1
  redrob-generate emit --template templates/math/linear-equation --count 8 --out /tmp/dod-d --quiet || status=1
  diff /tmp/dod-c/instances.jsonl /tmp/dod-d/instances.jsonl || status=1
  diff <(python3 -c 'import json,sys; d=json.load(open("/tmp/dod-c/manifest.json")); d.pop("created_at"); print(json.dumps(d,sort_keys=True,indent=1))') \
       <(python3 -c 'import json,sys; d=json.load(open("/tmp/dod-d/manifest.json")); d.pop("created_at"); print(json.dumps(d,sort_keys=True,indent=1))') || status=1
  echo "    identical apart from created_at"
  rm -rf /tmp/dod-c /tmp/dod-d
  return $status
}

# 3. The checked-in example set is still exactly what the emitter produces.
example_set_current() {
  redrob-generate emit --template templates/math/linear-equation --count 3 \
    --out spec/conformance/example-set --created-at 2026-01-01T00:00:00Z \
    --citation-year 2026 --quiet &&
    git diff --exit-code -- spec/conformance/example-set
}

step 01-build-without-python build_without_python
step 02-typecheck npx tsc --noEmit -p tsconfig.json
step 03-workspace-typecheck yarn typecheck
step 04-yarn-test yarn test
step 05-pip-install python3 -m pip install --break-system-packages -e "packages/generate[dev]"
step 06-pytest python3 -m pytest packages/generate -v
step 07-reproducible-emit reproducible_emit
step 08-example-set-current example_set_current
# 4. The two implementations produce the same verdict for every case, shown as a diff of
#    their actual output rather than inferred from two green suites.
zero_divergence() {
  local status=0
  npx tsx scripts/generate-verdicts.mts >/tmp/dod-ts-verdicts.json || status=1
  python3 scripts/generate_verdicts.py >/tmp/dod-py-verdicts.json || status=1
  echo "TypeScript verdicts: $(($(wc -l </tmp/dod-ts-verdicts.json) - 2)) cases"
  echo "Python verdicts:     $(($(wc -l </tmp/dod-py-verdicts.json) - 2)) cases"
  echo
  if diff -u /tmp/dod-py-verdicts.json /tmp/dod-ts-verdicts.json; then
    echo "zero divergence"
  else
    echo "the two implementations disagree on the cases listed above"
    status=1
  fi
  return $status
}

step 09-spec-types-drift yarn generate:spec-types:check
step 10-zero-divergence zero_divergence
step 11-existing-verifiers-unaffected yarn verify:phase1

# 5. The one line this branch adds to the shared root tsconfig must not change what Compare,
#    Evolve or Deploy compile to. Next.js embeds a random BUILD_ID and two random encryption
#    keys, so a raw hash diff is noise; the snapshot normalises the build id away and the
#    five per-build random files are excluded, which a control run proves is enough.
build_output_unchanged() {
  local status=0
  local snapshot="$ROOT/scripts/snapshot-build-output.py"
  local noise='  (trace|trace-build|prerender-manifest\.json|server/server-reference-manifest\.(js|json))$'

  echo "--- build with the tsconfig line present"
  rm -rf apps/web/.next
  yarn build >/dev/null 2>&1 || return 1
  python3 "$snapshot" | grep -vE "$noise" >/tmp/dod-build-with.txt

  echo "--- control: a second build of the identical tree"
  rm -rf apps/web/.next
  yarn build >/dev/null 2>&1 || return 1
  python3 "$snapshot" | grep -vE "$noise" >/tmp/dod-build-control.txt
  if diff /tmp/dod-build-with.txt /tmp/dod-build-control.txt; then
    echo "    two builds of the same tree agree on $(wc -l </tmp/dod-build-with.txt) artifacts,"
    echo "    so a difference below would be attributable to the tsconfig line"
  else
    echo "    the build is not reproducible even without a change, so this check cannot conclude"
    return 1
  fi

  echo "--- build with the tsconfig line removed"
  cp tsconfig.json /tmp/dod-tsconfig-keep.json
  python3 - <<'PY'
import json, re
from pathlib import Path
path = Path("tsconfig.json")
text = path.read_text()
# Drop the added option and the comment above it, leaving the file otherwise byte-identical.
text = re.sub(r',\n(?:\s*//[^\n]*\n)*\s*"allowImportingTsExtensions": true', "", text)
path.write_text(text)
assert "allowImportingTsExtensions" not in path.read_text()
PY
  rm -rf apps/web/.next
  yarn build >/dev/null 2>&1 || status=1
  python3 "$snapshot" | grep -vE "$noise" >/tmp/dod-build-without.txt
  cp /tmp/dod-tsconfig-keep.json tsconfig.json

  if diff /tmp/dod-build-with.txt /tmp/dod-build-without.txt; then
    echo "    identical across $(wc -l </tmp/dod-build-with.txt) artifacts"
    grep -E '  server/app/(compare|evolve|deploy)\.html$' /tmp/dod-build-with.txt
  else
    status=1
  fi
  return $status
}

step 12-build-output-unchanged build_output_unchanged

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "all checks passed"
else
  echo "$FAILURES check(s) failed"
fi
exit "$FAILURES"
