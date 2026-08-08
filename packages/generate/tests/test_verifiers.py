# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""Verifier behaviour that the conformance files cannot express.

The conformance files cover verdicts. This file covers the things that are supposed to
raise, and the executable tier, which by definition only exists on this side.
"""

from __future__ import annotations

import pytest

from typing import Any

from redrob_generate.errors import UnsupportedVerifierError
from redrob_generate.verify import (
    ALL_VERIFIER_TYPES,
    DECLARATIVE_VERIFIER_TYPES,
    EXECUTABLE_VERIFIER_TYPES,
    is_declarative,
    run_verifier,
    run_verifier_or_fail,
)


def test_verifier_registry_is_complete() -> None:
    assert set(ALL_VERIFIER_TYPES) == set(DECLARATIVE_VERIFIER_TYPES) | set(
        EXECUTABLE_VERIFIER_TYPES
    )
    assert not set(DECLARATIVE_VERIFIER_TYPES) & set(EXECUTABLE_VERIFIER_TYPES)
    assert set(EXECUTABLE_VERIFIER_TYPES) == {"sympy_equiv", "python_unittest"}


def test_unknown_verifier_type_raises_rather_than_passing() -> None:
    """The failure mode this project cannot tolerate is a verifier that quietly passes."""
    with pytest.raises(UnsupportedVerifierError):
        run_verifier({"type": "vibes"}, "anything")


def test_missing_verifier_type_raises() -> None:
    with pytest.raises(UnsupportedVerifierError):
        run_verifier({}, "anything")


@pytest.mark.parametrize("verifier_type", EXECUTABLE_VERIFIER_TYPES)
def test_executable_verifiers_refused_when_execution_is_not_permitted(verifier_type: str) -> None:
    verdict = run_verifier(
        {"type": verifier_type, "expected": "x", "test_source": "x"},
        "candidate",
        allow_executable=False,
    )
    assert verdict.passed is False
    assert verdict.code == "unsupported_verifier"


def test_is_declarative() -> None:
    assert is_declarative("exact")
    assert not is_declarative("sympy_equiv")
    assert not is_declarative("verifier_list"), (
        "a verifier list is a shape of the field, not a type the registry dispatches on"
    )


def test_a_verifier_list_refuses_an_executable_element() -> None:
    """A list is declarative by definition; an executable element would make it
    unsupported on one implementation and passing on the other."""
    with pytest.raises(UnsupportedVerifierError, match="declarative"):
        run_verifier([{"type": "sympy_equiv", "expected": "x"}], "x")


def test_a_verifier_list_refuses_an_executable_element_behind_a_failing_one() -> None:
    """The case that needed an eager pre-walk when this was a combinator.

    The first element fails, and the combinator stopped there, so the executable sibling
    was never reached and the caller got a mismatch describing output only half the
    contract had been applied to. Nothing in that verdict said so. Here the refusal needs
    no separate walk: there is no short circuit, so every element is reached.
    """
    verifiers = [
        {"type": "exact", "expected": "not the candidate"},
        {"type": "sympy_equiv", "expected": "x"},
    ]
    with pytest.raises(UnsupportedVerifierError):
        run_verifier(verifiers, "x")

    verdict = run_verifier_or_fail(verifiers, "x")
    assert verdict.passed is False
    assert verdict.code == "unsupported_verifier", (
        "a refused list must not be reported as an ordinary mismatch, because a mismatch "
        "means the list ran"
    )


@pytest.mark.parametrize("position", range(6))
def test_an_executable_element_at_any_position_makes_the_list_raise(position: int) -> None:
    """The corpus covers an executable element first, last, and behind a failure.

    This sweeps every position of a longer list, so the claim is "at every position"
    rather than "at the positions someone thought of". One element fails, so an
    implementation that stopped early would have something to return before reaching the
    executable one.
    """
    verifiers: list[Any] = [
        {"type": "exact", "expected": "not the candidate" if index == 1 else "42"}
        for index in range(6)
    ]
    verifiers[position] = {"type": "sympy_equiv", "expected": "x", "symbols": ["x"]}

    with pytest.raises(UnsupportedVerifierError):
        run_verifier(verifiers, "42")

    verdict = run_verifier_or_fail(verifiers, "42")
    assert verdict.passed is False
    assert verdict.code == "unsupported_verifier", (
        "a refused list reported as an ordinary verdict would mean it ran"
    )


def test_a_verifier_list_runs_every_element() -> None:
    """The behavioural difference from the combinator, asserted directly.

    Two elements fail. The combinator returned the first and said nothing about the
    second, so a template with an unusable pattern was indistinguishable from an answer
    that was merely wrong. The report names both.
    """
    verdict = run_verifier(
        [
            {"type": "exact", "expected": "not the candidate"},
            {"type": "regex", "pattern": "(unclosed"},
        ],
        "42",
    )
    assert (verdict.passed, verdict.code) == (False, "mismatch")
    assert verdict.detail["elements"] == [
        {"index": 0, "type": "exact", "passed": False, "code": "mismatch"},
        {"index": 1, "type": "regex", "passed": False, "code": "invalid_pattern"},
    ]


def test_a_single_verifier_reports_no_elements() -> None:
    """A one-element list and a bare verifier stay distinguishable in the verdict."""
    single = run_verifier({"type": "exact", "expected": "42"}, "42")
    listed = run_verifier([{"type": "exact", "expected": "42"}], "42")
    assert "elements" not in single.detail
    assert listed.detail["elements"] == [
        {"index": 0, "type": "exact", "passed": True, "code": "ok"}
    ]


def test_json_schema_rejects_out_of_subset_keywords() -> None:
    """An unsupported keyword is a configuration error, not something to ignore.

    Ignoring an assertion keyword turns a failing candidate into a passing one, and it
    would do so on only one of the two implementations.
    """
    with pytest.raises(ValueError, match="outside the supported subset"):
        run_verifier(
            {
                "type": "json_schema",
                "schema": {"if": {"type": "string"}, "then": {"minLength": 1}},
            },
            "{}",
        )


def test_json_schema_rejects_remote_refs() -> None:
    with pytest.raises(ValueError, match="local"):
        run_verifier(
            {"type": "json_schema", "schema": {"$ref": "https://example.com/schema.json"}},
            "{}",
        )


# ------------------------------------------------------------ executable tier


def test_sympy_equiv_accepts_an_equivalent_expression() -> None:
    verdict = run_verifier(
        {"type": "sympy_equiv", "expected": "(x + 1)**2", "symbols": ["x"]},
        "x**2 + 2*x + 1",
    )
    assert verdict.passed, verdict.message


def test_sympy_equiv_rejects_a_different_expression() -> None:
    verdict = run_verifier(
        {"type": "sympy_equiv", "expected": "(x + 1)**2", "symbols": ["x"]},
        "x**2 + 2*x + 2",
    )
    assert not verdict.passed
    assert verdict.code == "mismatch"


def test_sympy_equiv_rejects_undeclared_symbols() -> None:
    """Without this, a stray name becomes a new free symbol and the comparison quietly
    starts meaning something else."""
    verdict = run_verifier(
        {"type": "sympy_equiv", "expected": "x + 1", "symbols": ["x"]},
        "y + 1",
    )
    assert not verdict.passed
    assert verdict.code == "parse_error"


def test_sympy_equiv_strips_answer_labels() -> None:
    verdict = run_verifier(
        {
            "type": "sympy_equiv",
            "expected": "2*x",
            "symbols": ["x"],
            "strip_prefixes": ["Answer:"],
        },
        "Answer: x + x",
    )
    assert verdict.passed, verdict.message


def test_sympy_equiv_on_garbage_is_a_parse_error() -> None:
    verdict = run_verifier(
        {"type": "sympy_equiv", "expected": "x", "symbols": ["x"]},
        "I am not sure, sorry",
    )
    assert not verdict.passed
    assert verdict.code == "parse_error"


def test_python_unittest_passes_correct_code() -> None:
    verdict = run_verifier(
        {
            "type": "python_unittest",
            "test_source": (
                "import unittest\n"
                "from candidate import add\n"
                "class T(unittest.TestCase):\n"
                "    def test_add(self):\n"
                "        self.assertEqual(add(2, 3), 5)\n"
            ),
        },
        "def add(a, b):\n    return a + b\n",
    )
    assert verdict.passed, verdict.message


def test_python_unittest_fails_wrong_code() -> None:
    verdict = run_verifier(
        {
            "type": "python_unittest",
            "test_source": (
                "import unittest\n"
                "from candidate import add\n"
                "class T(unittest.TestCase):\n"
                "    def test_add(self):\n"
                "        self.assertEqual(add(2, 3), 5)\n"
            ),
        },
        "def add(a, b):\n    return a * b\n",
    )
    assert not verdict.passed


def test_python_unittest_times_out_rather_than_hanging() -> None:
    verdict = run_verifier(
        {
            "type": "python_unittest",
            "timeout_seconds": 1,
            "test_source": (
                "import unittest\n"
                "import candidate\n"
                "class T(unittest.TestCase):\n"
                "    def test_ok(self):\n"
                "        self.assertTrue(True)\n"
            ),
        },
        "import time\ntime.sleep(30)\n",
    )
    assert not verdict.passed
    assert "within" in verdict.message
