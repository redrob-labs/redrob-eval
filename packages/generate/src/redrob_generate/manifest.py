# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""Manifest emission, per spec sections 1.4 and 8.

The manifest is what makes a shared set auditable: the generator version and template
hashes let a third party regenerate it, and the BibTeX entry travels with the data so
that a citation is available to whoever ends up holding the files, not just to whoever
read the repository.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Mapping, Sequence

from .__about__ import (
    GENERATOR_NAME,
    GENERATOR_VERSION,
    SPEC_VERSION,
    TOOL_NAME,
    TOOL_VERSION,
)
from .seed import SEED_FORMULA, SEED_INPUTS, SEED_METHOD

# Minted at first release. Until then the placeholder is honest about what it is,
# rather than pointing at a DOI that does not resolve.
PLACEHOLDER_DOI = "TBD"

CITATION_NOTICE = (
    "Generated with redrob-generate. Please cite: see citation.bibtex in manifest.json "
    "and CITATION.cff in the repository."
)


def bibtex_entry(year: int | None = None, doi: str = PLACEHOLDER_DOI) -> str:
    """A ready-to-paste BibTeX entry.

    ``year`` is an explicit argument rather than a clock read, so that two emit runs
    with the same inputs produce byte-identical manifests apart from ``created_at``.
    """
    resolved_year = year if year is not None else 2026
    return (
        "@software{redrob_eval,\n"
        "  title = {redrob-eval: an open LLM evaluation workbench with "
        "contamination-resistant generated tasks},\n"
        "  author = {Lee, Janghoon},\n"
        f"  year = {{{resolved_year}}},\n"
        f"  version = {{{TOOL_VERSION}}},\n"
        f"  doi = {{{doi}}},\n"
        "  url = {https://github.com/redrob-labs/redrob-eval},\n"
        "  license = {Apache-2.0}\n"
        "}"
    )


def utc_now_rfc3339() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def build_manifest(
    *,
    templates: Sequence[Mapping[str, Any]],
    instance_count: int,
    locale: str,
    created_at: str | None = None,
    fertility: Mapping[str, Any] | None = None,
    doi: str = PLACEHOLDER_DOI,
    citation_year: int | None = None,
) -> dict[str, Any]:
    """Build the manifest for one generated set.

    ``templates`` entries are ``{id, version, locale, content_hash, instance_count}``.
    """
    manifest: dict[str, Any] = {
        "spec_version": SPEC_VERSION,
        "generator_name": GENERATOR_NAME,
        "generator_version": GENERATOR_VERSION,
        "tool": {"name": TOOL_NAME, "version": TOOL_VERSION},
        "created_at": created_at or utc_now_rfc3339(),
        "locale": locale,
        "instance_count": instance_count,
        "templates": [dict(entry) for entry in templates],
        "seed_derivation": {
            "method": SEED_METHOD,
            "formula": SEED_FORMULA,
            "inputs": list(SEED_INPUTS),
        },
        "citation": {
            "doi": doi,
            "bibtex": bibtex_entry(citation_year, doi),
            "notice": CITATION_NOTICE,
        },
    }
    if fertility is not None:
        manifest["fertility"] = dict(fertility)
    return manifest
