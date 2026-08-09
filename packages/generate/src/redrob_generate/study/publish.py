# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""What a results artifact must satisfy before it can be published.

Two refusals, for two different failure modes that look identical from the outside --
a table of numbers that appears finished.

The first is linguistic. A stub locale renders the English prompt verbatim, so a run
over it completes, scores, and produces a token count per locale that looks exactly like
a real measurement and is in fact a measurement of English tokenised four times. Nothing
downstream can detect that from the numbers, so it has to be refused here.

The second is provenance. The two implementations agree on the whole conformance corpus
but read different Unicode tables, so a verdict from the display implementation is not
one this project is willing to stand behind in a published artifact.

Both are checked against the artifact rather than trusted from the run that produced it,
so an artifact that arrived from somewhere else is checked the same way.
"""

from __future__ import annotations

from typing import Any, Mapping

from ..errors import RedrobGenerateError
from ..provenance import is_authoritative


class PublicationRefused(RedrobGenerateError):
    """The artifact is well formed but must not be published."""


PUBLISHABLE_STATUSES = ("native-reviewed", "single-reviewer")


def untranslated_locales(result: Mapping[str, Any]) -> list[str]:
    return sorted(
        str(locale.get("tag"))
        for locale in result.get("locales", [])
        if locale.get("translation_status") not in PUBLISHABLE_STATUSES
    )


def non_authoritative_implementations(result: Mapping[str, Any]) -> list[str]:
    """Implementations that produced at least one verdict and are not authoritative."""
    offenders: set[str] = set()
    for instance in result.get("instances", []):
        provenance = instance.get("verdict_provenance")
        if not is_authoritative(provenance):
            name = "(missing provenance)"
            if isinstance(provenance, Mapping):
                name = str(provenance.get("implementation", "(unnamed)"))
            offenders.add(name)
    return sorted(offenders)


def assert_publishable(result: Mapping[str, Any]) -> None:
    """Raise :class:`PublicationRefused` unless the artifact may be published."""
    problems: list[str] = []

    stubs = untranslated_locales(result)
    if stubs:
        problems.append(
            f"locale(s) {stubs} are untranslated; their prompts are placeholder text, so "
            "a per-locale number computed over them measures the placeholder rather than "
            "the locale"
        )

    offenders = non_authoritative_implementations(result)
    if offenders:
        problems.append(
            f"verdicts were produced by {offenders}, which are not authoritative; only "
            "redrob-generate verdicts may be published, because the runtimes read "
            "different Unicode tables"
        )

    if problems:
        raise PublicationRefused(
            "refusing to publish this study artifact:\n  - " + "\n  - ".join(problems)
        )
