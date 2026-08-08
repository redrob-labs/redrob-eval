# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""Read both runtimes' Unicode tables and say exactly where they disagree.

Every comparison verifier in this spec routes through ``unicodedata.normalize`` on this
side and ``String.prototype.normalize`` on the other, and ``case_sensitive: false`` routes
through ``str.lower()`` and ``String.prototype.toLowerCase``. Neither pair is implemented
here. They are two separate implementations over two separately versioned copies of the
Unicode character database, and the conformance corpus can only ever exercise the handful
of characters someone thought to write down.

So this test reads the whole table on both sides, all 1 112 064 code points, and asserts
the two properties the spec actually claims:

1. **NFC agrees everywhere, with no allowance.** NFC is the default for every comparison
   verifier, so a single disagreement anywhere in the range would mean two models with the
   same visible answer can score differently depending on which implementation graded
   them. This assertion has no escape hatch and is meant not to.

2. **Every other disagreement is about a character this Python has never heard of.** The
   two runtimes carry different Unicode versions, so the newer one knows mappings for code
   points the older one has not been told exist. That is a version skew and it is
   survivable. A disagreement about a character *both* sides consider assigned would be a
   genuine contradiction between two implementations of the same standard, and is a hard
   failure here.

The residual this leaves is stated rather than hidden: a template declaring NFD, NFKC,
NFKD or ``case_sensitive: false`` is reproducible only across runtimes carrying the same
Unicode version, and the set of characters at risk is printed by this test's failure
message. See docs/decisions/0002-unicode-semantics.md.
"""

from __future__ import annotations

import shutil
import subprocess
import unicodedata
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
DUMP_SCRIPT = REPO_ROOT / "scripts" / "unicode-tables.mts"

#: Operations dumped by the script, in the order it emits them.
OPERATIONS = ("NFC", "NFD", "NFKC", "NFKD", "lowercase")


def _python_table(operation: str) -> dict[int, str]:
    """Every code point this interpreter changes under ``operation``, and its result."""
    table: dict[int, str] = {}
    for code_point in range(0x110000):
        if 0xD800 <= code_point <= 0xDFFF:
            continue
        character = chr(code_point)
        if operation == "lowercase":
            result = character.lower()
        else:
            result = unicodedata.normalize(operation, character)
        if result != character:
            table[code_point] = result
    return table


def _parse(dump: str) -> tuple[str, dict[str, dict[int, str]]]:
    runtime = ""
    tables: dict[str, dict[int, str]] = {}
    current: dict[int, str] | None = None
    for line in dump.splitlines():
        if line.startswith("# runtime "):
            runtime = line[len("# runtime ") :]
            continue
        if line.startswith("# "):
            current = {}
            tables[line[2:]] = current
            continue
        if not line:
            continue
        assert current is not None, "a mapping line appeared before any section header"
        left, right = line.split("\t")
        current[int(left, 16)] = "".join(chr(int(part, 16)) for part in right.split(" "))
    return runtime, tables


@pytest.fixture(scope="module")
def runtimes() -> tuple[str, dict[str, dict[int, str]]]:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not on PATH, so the other runtime's tables cannot be read")
    npx = shutil.which("npx")
    if npx is None:
        pytest.skip("npx is not on PATH, so the dump script cannot be run")
    completed = subprocess.run(
        [npx, "--no-install", "tsx", str(DUMP_SCRIPT)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=600,
    )
    if completed.returncode != 0:
        pytest.skip(f"the dump script did not run: {completed.stderr.strip()[:400]}")
    return _parse(completed.stdout)


def _describe(code_points: list[int], limit: int = 12) -> str:
    shown = ", ".join(
        f"U+{point:04X} ({unicodedata.category(chr(point))})" for point in code_points[:limit]
    )
    more = f" and {len(code_points) - limit} more" if len(code_points) > limit else ""
    return shown + more


def test_the_dump_covers_every_operation(runtimes: tuple[str, dict]) -> None:
    _runtime, tables = runtimes
    assert set(tables) == set(OPERATIONS), f"the dump is missing {set(OPERATIONS) - set(tables)}"
    for operation in OPERATIONS:
        assert len(tables[operation]) > 1000, (
            f"the {operation} table has {len(tables[operation])} entries, which is too few "
            "to be a real Unicode table; the dump is probably broken"
        )


def test_nfc_agrees_on_every_code_point(runtimes: tuple[str, dict]) -> None:
    """No allowance. NFC is the default, so this one has to be exact."""
    _runtime, tables = runtimes
    mine = _python_table("NFC")
    theirs = tables["NFC"]
    disagreements = sorted(
        point for point in set(mine) | set(theirs) if mine.get(point) != theirs.get(point)
    )
    assert not disagreements, (
        f"NFC differs on {len(disagreements)} code point(s): {_describe(disagreements)}. "
        "NFC is the default normalisation for every comparison verifier, so this means two "
        "implementations can score the same visible answer differently."
    )


@pytest.mark.parametrize("operation", ["NFD", "NFKC", "NFKD", "lowercase"])
def test_every_other_disagreement_is_a_character_this_python_does_not_know(
    operation: str, runtimes: tuple[str, dict]
) -> None:
    runtime, tables = runtimes
    mine = _python_table(operation)
    theirs = tables[operation]
    disagreements = sorted(
        point for point in set(mine) | set(theirs) if mine.get(point) != theirs.get(point)
    )
    # 'Cn' is unassigned. A disagreement about an unassigned code point is the two
    # character databases being at different versions; a disagreement about an assigned one
    # is two implementations reading the same standard differently.
    contradictions = [
        point for point in disagreements if unicodedata.category(chr(point)) != "Cn"
    ]
    assert not contradictions, (
        f"{operation} differs on {len(contradictions)} code point(s) that this Python "
        f"considers assigned: {_describe(contradictions)}. This is not a Unicode version "
        f"skew (unicodedata {unicodedata.unidata_version} against {runtime}); it is two "
        "implementations of the same standard disagreeing, and it makes any template "
        f"declaring {operation} unscoreable."
    )
    # Recorded rather than asserted away: the skew is real and a template using this
    # operation is only reproducible across runtimes at the same Unicode version.
    print(
        f"{operation}: {len(disagreements)} code point(s) differ, all unassigned in "
        f"unicodedata {unicodedata.unidata_version}"
    )


def test_the_comparison_can_fail(runtimes: tuple[str, dict]) -> None:
    """The negative control.

    A parity test that reads two tables and finds them equal proves nothing unless a
    difference would have been noticed. This perturbs one entry of the other runtime's NFC
    table and checks that the same comparison the test above performs rejects it.
    """
    _runtime, tables = runtimes
    mine = _python_table("NFC")
    theirs = dict(tables["NFC"])
    assert mine == theirs, "the unperturbed tables must be equal for this control to mean anything"

    # U+00C5 ANGSTROM SIGN territory: pick any entry and change its result by one character.
    victim = min(theirs)
    theirs[victim] = theirs[victim] + "x"
    disagreements = [
        point for point in set(mine) | set(theirs) if mine.get(point) != theirs.get(point)
    ]
    assert disagreements == [victim], (
        "perturbing one NFC mapping did not produce exactly one disagreement, so the "
        "comparison is not actually comparing results"
    )

    # And an entry present on one side only, which is the other shape a real skew takes.
    theirs = dict(tables["NFC"])
    theirs[0x10FFFD] = "\u0061"
    assert 0x10FFFD in [
        point for point in set(mine) | set(theirs) if mine.get(point) != theirs.get(point)
    ]
