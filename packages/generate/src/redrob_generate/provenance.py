# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""Who produced a verdict, and whether it may be published.

The two implementations of the declarative verifiers agree on every row of the
conformance corpus, and that agreement is checked on every build. It is still not a
reason to treat them as interchangeable when a result is going to be published, for one
reason that no amount of parity testing removes: they read different Unicode tables.
CPython's ``unicodedata`` is compiled against one version of the Unicode Character
Database and Node's ICU against another, so a normalisation or a case mapping involving
a code point assigned between those two versions can differ even though both
implementations are behaving correctly.

The policy is therefore about provenance rather than correctness. Python is normative
and its verdicts are marked authoritative. TypeScript may verify anything it likes for
display, and says so in the record. A publishable artifact refuses to build from the
non-authoritative kind, so the distinction cannot be lost by the time someone is reading
a number.
"""

from __future__ import annotations

import unicodedata
from typing import Any, Mapping

from .__about__ import GENERATOR_NAME, GENERATOR_VERSION

#: The implementation this package is. Recorded verbatim in every verdict record it
#: produces, so an artifact naming something else was not produced here.
IMPLEMENTATION = GENERATOR_NAME

#: Version of the Unicode Character Database CPython was built against. Read at import
#: rather than pinned, because pinning it would record a claim instead of a measurement.
UNICODE_VERSION = unicodedata.unidata_version


def local_provenance() -> dict[str, Any]:
    """The provenance block for a verdict this process produced."""
    return {
        "implementation": IMPLEMENTATION,
        "implementation_version": GENERATOR_VERSION,
        "unicode_version": UNICODE_VERSION,
        "authoritative": True,
    }


def is_authoritative(provenance: Mapping[str, Any] | None) -> bool:
    """Whether a provenance block marks its verdict publishable.

    A missing block is not authoritative. Absence has to fail closed here: a record
    written before this field existed, or by a tool that does not know about it, is
    exactly the case where its origin is unknown.
    """
    if not isinstance(provenance, Mapping):
        return False
    return provenance.get("authoritative") is True
