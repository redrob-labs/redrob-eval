# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""Dump the verdict this implementation produces for every conformance case.

Run: python3 scripts/generate_verdicts.py > /tmp/py.json

Its counterpart is ``scripts/generate-verdicts.mts``. Each conformance suite already checks
its own side against the expected verdict in the case file, which is enough to catch a
divergence; diffing these two dumps is what *shows* it, as a list of case ids rather than
as two separate red builds that a reader has to correlate by hand.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from redrob_generate.verify import DECLARATIVE_VERIFIER_TYPES, run_verifier_or_fail

DIRECTORY = Path(__file__).resolve().parent.parent / "spec" / "conformance"


def main() -> int:
    verdicts: dict[str, list[object]] = {}
    for path in sorted(DIRECTORY.glob("*.json")):
        if path.stem not in DECLARATIVE_VERIFIER_TYPES:
            continue
        document = json.loads(path.read_text(encoding="utf-8"))
        # Rejection rows are dumped too, so a configuration that must be refused is
        # compared across implementations rather than only within each one. A malformed
        # configuration raises rather than producing a verdict, and the raise is recorded
        # as such: turning it into a verdict here would hide the difference the comparison
        # is looking for.
        for case in document["cases"] + document.get("rejections", []):
            try:
                verdict = run_verifier_or_fail(case["verifier"], case["candidate"])
                verdicts[case["id"]] = [verdict.passed, verdict.code]
            except ValueError:
                verdicts[case["id"]] = ["raises", "verifier_config"]

    # Separators pinned to match JSON.stringify, so that a diff of the two dumps shows a
    # disagreement about verdicts rather than about whitespace.
    lines = [
        f"  {json.dumps(key)}: {json.dumps(verdicts[key], separators=(',', ':'))}"
        for key in sorted(verdicts)
    ]
    sys.stdout.write("{\n" + ",\n".join(lines) + "\n}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
