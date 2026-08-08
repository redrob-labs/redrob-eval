# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""Verifier behaviour that the conformance files cannot express.

The conformance files cover verdicts. This file covers the things that are supposed to
raise, and the executable tier, which by definition only exists on this side.
"""

from __future__ import annotations

import pytest

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
    assert is_declarative("all_of")
    assert not is_declarative("sympy_equiv")


def test_all_of_rejects_an_executable_child() -> None:
    """all_of is declarative by definition; an executable child would make it
    unsupported on one implementation and passing on the other."""
    with pytest.raises(UnsupportedVerifierError, match="must be declarative"):
        run_verifier(
            {
                "type": "all_of",
                "verifiers": [{"type": "sympy_equiv", "expected": "x"}],
            },
            "x",
        )


def test_all_of_rejects_an_executable_child_before_evaluating_anything() -> None:
    """The eager case, which is the one that matters.

    The first child fails, so a lazy implementation returns its mismatch verdict and never
    reaches the executable sibling. That verdict describes output only half of the
    contract was applied to, and nothing in it says so.
    """
    composite = {
        "type": "all_of",
        "verifiers": [
            {"type": "exact", "expected": "not the candidate"},
            {"type": "sympy_equiv", "expected": "x"},
        ],
    }
    with pytest.raises(UnsupportedVerifierError):
        run_verifier(composite, "x")

    verdict = run_verifier_or_fail(composite, "x")
    assert verdict.passed is False
    assert verdict.code == "unsupported_verifier", (
        "a refused composite must not be reported as an ordinary mismatch, because a "
        "mismatch means the composite ran"
    )


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
