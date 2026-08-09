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
from redrob_generate.verify.regex_subset import scan as scan_regex_pattern

DIRECTORY = Path(__file__).resolve().parent.parent / "spec" / "conformance"


def token_signature(pattern: str) -> str:
    """The token stream a pattern scans to, alongside the verdict it produces.

    The two scanners walk a pattern with an index, and the thing being indexed is not the
    same on the two sides: a Python string steps by code point and a JavaScript string
    steps by UTF-16 code unit, so an astral character is one step here and two there. The
    JavaScript scanner reassembles surrogate pairs to compensate. Comparing verdicts alone
    would not notice if it stopped: a pattern can tokenise differently and still match or
    fail to match the same candidate. Comparing the token stream does.
    """
    try:
        return " ".join(f"{token.kind}:{token.text}" for token in scan_regex_pattern(pattern))
    except Exception as exc:  # the error class is the signal, not the message
        return f"error:{type(exc).__name__}"


#: Corpus files to dump: one per declarative verifier, plus the list-valued shape of the
#: verifier field, which is not a type the registry dispatches on.
CORPUS_NAMES = frozenset(DECLARATIVE_VERIFIER_TYPES) | {"verifier_list"}


def main() -> int:
    verdicts: dict[str, list[object]] = {}
    for path in sorted(DIRECTORY.glob("*.json")):
        if path.stem not in CORPUS_NAMES:
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
                # The per-element report is normative for a list, so it is compared here
                # too: an implementation can reach the right overall code by running the
                # wrong elements, and that difference is invisible in the pair above.
                elements = verdict.detail.get("elements")
                if elements is not None:
                    verdicts[f"elements:{case['id']}"] = [
                        f"{entry['index']}:{entry['type']}:{entry['passed']}:{entry['code']}"
                        for entry in elements
                    ]
            except ValueError:
                verdicts[case["id"]] = ["raises", "verifier_config"]
            elements = case["verifier"] if isinstance(case["verifier"], list) else [case["verifier"]]
            for index, node in enumerate(elements):
                if not isinstance(node, dict) or node.get("type") != "regex":
                    continue
                pattern = node.get("pattern")
                if isinstance(pattern, str):
                    suffix = f"[{index}]" if isinstance(case["verifier"], list) else ""
                    verdicts[f"tokens:{case['id']}{suffix}"] = [
                        "raises",
                        token_signature(pattern),
                    ]

    # Separators pinned to match JSON.stringify, and ensure_ascii off for the same reason:
    # JSON.stringify emits an astral character literally and json.dumps would escape it to
    # a surrogate pair, which would show up as a divergence about encoding rather than
    # about behaviour.
    lines = [
        f"  {json.dumps(key, ensure_ascii=False)}: "
        f"{json.dumps(verdicts[key], separators=(',', ':'), ensure_ascii=False)}"
        for key in sorted(verdicts)
    ]
    sys.stdout.write("{\n" + ",\n".join(lines) + "\n}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
