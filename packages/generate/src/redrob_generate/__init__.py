# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""redrob-generate: parametric generation of verifiable evaluation tasks.

Reference implementation of the Redrob Verifiable Task Spec v2
(``spec/verifiable-task-v2.md``). The TypeScript implementation under
``packages/harness/src/generate/`` is a peer, not a client: neither is authoritative
over the other, and ``spec/conformance/`` is what keeps them honest.
"""

from __future__ import annotations

from .__about__ import (
    GENERATOR_NAME,
    GENERATOR_VERSION,
    SPEC_VERSION,
    TOOL_NAME,
    TOOL_VERSION,
)
from .canonical import canonical_json, content_hash
from .errors import (
    ExpressionError,
    RedrobGenerateError,
    RenderError,
    SamplingError,
    SpecError,
    TemplateLoadError,
    UnsupportedVerifierError,
)
from .fertility import FertilityRecord, Tokenizer, measure_instance, summarize
from .generate import build_instance, build_instances
from .manifest import bibtex_entry, build_manifest
from .prng import SplitMix64
from .render import render_prompt, resolve_bindings
from .sample import sample_parameters
from .seed import derive_seed, seed_message, seed_to_string
from .spec import load_template, template_content_hash, validate_document
from .verify import (
    ALL_VERIFIER_TYPES,
    DECLARATIVE_VERIFIER_TYPES,
    EXECUTABLE_VERIFIER_TYPES,
    Verdict,
    run_verifier,
)

__version__ = GENERATOR_VERSION

__all__ = [
    "ALL_VERIFIER_TYPES",
    "DECLARATIVE_VERIFIER_TYPES",
    "EXECUTABLE_VERIFIER_TYPES",
    "GENERATOR_NAME",
    "GENERATOR_VERSION",
    "SPEC_VERSION",
    "TOOL_NAME",
    "TOOL_VERSION",
    "ExpressionError",
    "FertilityRecord",
    "RedrobGenerateError",
    "RenderError",
    "SamplingError",
    "SpecError",
    "SplitMix64",
    "TemplateLoadError",
    "Tokenizer",
    "UnsupportedVerifierError",
    "Verdict",
    "__version__",
    "bibtex_entry",
    "build_instance",
    "build_instances",
    "build_manifest",
    "canonical_json",
    "content_hash",
    "derive_seed",
    "load_template",
    "measure_instance",
    "render_prompt",
    "resolve_bindings",
    "run_verifier",
    "sample_parameters",
    "seed_message",
    "seed_to_string",
    "summarize",
    "template_content_hash",
    "validate_document",
]
