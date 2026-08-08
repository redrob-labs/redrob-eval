# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""Verifier registry.

``run_verifier`` dispatches on the type tag. An unknown type raises
:class:`UnsupportedVerifierError`; it never returns a passing verdict, because a
verifier that fails to run and is counted as a pass is the one bug this project cannot
tolerate.
"""

from __future__ import annotations

from typing import Any, Callable, Mapping

from ..errors import UnsupportedVerifierError
from .base import SPEC_WHITESPACE, VERDICT_CODES, Verdict, fail, ok, require_well_formed
from .declarative import DECLARATIVE_VERIFIERS
from .executable import EXECUTABLE_VERIFIER_TYPES, EXECUTABLE_VERIFIERS

DECLARATIVE_VERIFIER_TYPES = tuple(DECLARATIVE_VERIFIERS)
ALL_VERIFIER_TYPES = DECLARATIVE_VERIFIER_TYPES + EXECUTABLE_VERIFIER_TYPES

_REGISTRY: dict[str, Callable[[Mapping[str, Any], str], Verdict]] = {
    **DECLARATIVE_VERIFIERS,
    **EXECUTABLE_VERIFIERS,
}


def is_declarative(verifier_type: str) -> bool:
    return verifier_type in DECLARATIVE_VERIFIERS


def run_verifier(
    verifier: Mapping[str, Any],
    candidate: str,
    *,
    allow_executable: bool = True,
) -> Verdict:
    """Run one verifier against one candidate output.

    ``allow_executable=False`` is for callers that refuse to execute model-derived code.
    It produces an explicit ``unsupported_verifier`` failure, never a pass.
    """
    verifier_type = verifier.get("type")
    if not isinstance(verifier_type, str) or verifier_type not in _REGISTRY:
        raise UnsupportedVerifierError(str(verifier_type), "no implementation is registered")
    # Checked here rather than in each verifier, so a field added later inherits the rule.
    require_well_formed(verifier, f"the {verifier_type} verifier's configuration")
    if verifier_type in EXECUTABLE_VERIFIER_TYPES and not allow_executable:
        return fail(
            "unsupported_verifier",
            f"{verifier_type} is an executable verifier and execution was not permitted",
            verifier_type=verifier_type,
        )
    return _REGISTRY[verifier_type](verifier, candidate)


def run_verifier_or_fail(
    verifier: Mapping[str, Any],
    candidate: str,
    *,
    allow_executable: bool = True,
) -> Verdict:
    """The same dispatch, with an unsupported type turned into a failing verdict.

    The peer of ``runVerifierOrFail`` on the TypeScript side, and it exists for the same
    reason: a caller scoring a whole set wants one bad verifier to fail its own item
    rather than abort the run. Still a failure, never a pass, so nothing scored this way
    can be counted as correct by mistake.
    """
    try:
        return run_verifier(verifier, candidate, allow_executable=allow_executable)
    except UnsupportedVerifierError as exc:
        return fail(
            "unsupported_verifier",
            str(exc),
            verifier_type=exc.verifier_type,
        )


__all__ = [
    "ALL_VERIFIER_TYPES",
    "DECLARATIVE_VERIFIER_TYPES",
    "EXECUTABLE_VERIFIER_TYPES",
    "SPEC_WHITESPACE",
    "VERDICT_CODES",
    "UnsupportedVerifierError",
    "Verdict",
    "fail",
    "is_declarative",
    "ok",
    "run_verifier",
    "run_verifier_or_fail",
]
