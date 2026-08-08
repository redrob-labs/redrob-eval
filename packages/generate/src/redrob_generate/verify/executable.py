# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""The executable tier, per spec section 6.2. Python only.

Both verifiers here execute code derived from a model's output. Nothing in this module
is a sandbox, and the spec does not pretend otherwise: run these only on content you
are willing to execute, or behind an external sandbox.

A non-Python implementation must raise an explicit unsupported-verifier error for these
types. Not a skip, and never a pass.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from typing import Any, Mapping

from .base import Verdict, fail, ok

EXECUTABLE_VERIFIER_TYPES = ("sympy_equiv", "python_unittest")


def verify_sympy_equiv(config: Mapping[str, Any], candidate: str) -> Verdict:
    """Symbolic equivalence of the candidate expression and the expected expression."""
    import sympy
    from sympy.parsing.sympy_parser import parse_expr, standard_transformations

    text = candidate
    for prefix in config.get("strip_prefixes", []):
        if text.lstrip().startswith(prefix):
            text = text.lstrip()[len(prefix) :]
            break
    text = text.strip()
    if text == "":
        return fail("parse_error", "candidate is empty")

    # Declared symbols only. Without this, an undeclared name becomes a brand new free
    # symbol and the comparison quietly starts meaning something else.
    local_dict = {name: sympy.Symbol(name) for name in config.get("symbols", [])}
    transformations = standard_transformations

    def parse(source: str) -> Any:
        return parse_expr(
            source,
            local_dict=local_dict,
            transformations=transformations,
            evaluate=True,
        )

    try:
        candidate_expr = parse(text)
    except Exception as exc:  # noqa: BLE001 - a model can emit anything
        return fail("parse_error", f"candidate did not parse as an expression: {exc}")
    try:
        expected_expr = parse(str(config["expected"]))
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"expected expression did not parse: {exc}") from exc

    undeclared = {symbol.name for symbol in candidate_expr.free_symbols} - set(local_dict)
    if undeclared:
        return fail(
            "parse_error",
            f"candidate introduces undeclared symbols: {sorted(undeclared)}",
            undeclared=sorted(undeclared),
        )

    mode = config.get("mode", "simplify_zero")
    try:
        if mode == "equals":
            equivalent = bool(expected_expr.equals(candidate_expr))
        else:
            equivalent = sympy.simplify(candidate_expr - expected_expr) == 0
    except Exception as exc:  # noqa: BLE001
        return fail("parse_error", f"equivalence check failed: {exc}")

    if equivalent:
        return ok("expressions are symbolically equivalent")
    return fail("mismatch", "expressions are not symbolically equivalent")


_RUNNER = """
import json
import sys
import unittest

loader = unittest.TestLoader()
suite = loader.loadTestsFromName("tests_module")
runner = unittest.TextTestRunner(stream=open("/dev/null", "w"), verbosity=0)
result = runner.run(suite)
print(json.dumps({
    "run": result.testsRun,
    "failures": len(result.failures),
    "errors": len(result.errors),
    "detail": [str(entry[1]).splitlines()[-1] for entry in result.failures + result.errors][:5],
}))
"""


def verify_python_unittest(config: Mapping[str, Any], candidate: str) -> Verdict:
    """Write the candidate to a module and run the supplied unittest source against it."""
    module_name = config.get("candidate_module", "candidate")
    timeout = float(config.get("timeout_seconds", 10))

    with tempfile.TemporaryDirectory(prefix="redrob-unittest-") as workdir:
        candidate_path = os.path.join(workdir, f"{module_name}.py")
        with open(candidate_path, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(candidate)
        tests_path = os.path.join(workdir, "tests_module.py")
        with open(tests_path, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(config["test_source"])
        runner_path = os.path.join(workdir, "_run.py")
        with open(runner_path, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(_RUNNER)

        environment = dict(os.environ)
        environment["PYTHONPATH"] = workdir
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        try:
            completed = subprocess.run(  # noqa: S603 - the whole point of this verifier
                [sys.executable, runner_path],
                cwd=workdir,
                env=environment,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return fail("mismatch", f"tests did not finish within {timeout} seconds")

    stdout = completed.stdout.strip().splitlines()
    if not stdout:
        return fail(
            "mismatch",
            "test runner produced no result",
            stderr=completed.stderr.strip()[-500:],
        )
    try:
        summary = json.loads(stdout[-1])
    except ValueError:
        return fail("mismatch", "test runner output was not JSON", stdout=stdout[-1][:500])

    if summary["failures"] == 0 and summary["errors"] == 0 and summary["run"] > 0:
        return ok(f"{summary['run']} tests passed")
    return fail(
        "mismatch",
        f"{summary['failures']} failures and {summary['errors']} errors in "
        f"{summary['run']} tests",
        **summary,
    )


EXECUTABLE_VERIFIERS = {
    "sympy_equiv": verify_sympy_equiv,
    "python_unittest": verify_python_unittest,
}
