# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""Verifier registry.

``run_verifier`` takes what a verifier field holds: one verifier object, or a list of
declarative verifiers all of which must pass. It dispatches on the type tag. An unknown
type raises :class:`UnsupportedVerifierError`; it never returns a passing verdict, because
a verifier that fails to run and is counted as a pass is the one bug this project cannot
tolerate.
"""

from __future__ import annotations

from collections.abc import Sequence
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


def run_verifier_list(
    verifiers: Sequence[Mapping[str, Any]],
    candidate: str,
) -> Verdict:
    """Run every verifier in a list against the same candidate. All must pass.

    **Every element runs, always.** There is no short circuit, and that is the whole of
    what makes the per-element report meaningful: a caller gets a verdict for each element
    rather than a verdict for the first one that happened to fail plus silence about the
    rest. It also removes a failure mode the composite this replaces had, where an element
    with an unusable configuration was never reached because an earlier element failed
    first, so a template that could not be scored looked like an answer that was wrong.

    The overall ``code`` is the first failing element's, verbatim, so ordering the elements
    still chooses which diagnosis leads. ``detail['elements']`` carries all of them.

    Elements must be declarative. That is enforced by the schema — a verifier list
    references the declarative union, so an executable element is a load-time violation —
    and again here, because this function is reachable without a schema check.
    """
    results: list[dict[str, Any]] = []
    first_failure: Verdict | None = None
    for index, element in enumerate(verifiers):
        where = f"verifier[{index}]"
        element_type = element.get("type") if isinstance(element, Mapping) else None
        if not isinstance(element_type, str) or element_type not in DECLARATIVE_VERIFIERS:
            raise UnsupportedVerifierError(
                str(element_type),
                f"{where} is not a declarative verifier; a verifier list may only contain "
                "types every implementation evaluates identically",
            )
        verdict = run_verifier(element, candidate)
        results.append(
            {
                "index": index,
                "type": element_type,
                "passed": verdict.passed,
                "code": verdict.code,
            }
        )
        if not verdict.passed and first_failure is None:
            first_failure = verdict
    if first_failure is None:
        return Verdict(True, "ok", f"all {len(results)} verifiers passed", {"elements": results})
    return Verdict(
        False,
        first_failure.code,
        first_failure.message,
        {**first_failure.detail, "elements": results},
    )


def run_verifier(
    verifier: Mapping[str, Any] | Sequence[Mapping[str, Any]],
    candidate: str,
    *,
    allow_executable: bool = True,
) -> Verdict:
    """Run a verifier field against one candidate output.

    ``verifier`` is either one verifier object or a list of declarative verifiers, all of
    which must pass; see :func:`run_verifier_list`.

    ``allow_executable=False`` is for callers that refuse to execute model-derived code.
    It produces an explicit ``unsupported_verifier`` failure, never a pass.
    """
    if isinstance(verifier, (list, tuple)):
        return run_verifier_list(verifier, candidate)
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
    verifier: Mapping[str, Any] | Sequence[Mapping[str, Any]],
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
    "run_verifier_list",
    "run_verifier_or_fail",
]
