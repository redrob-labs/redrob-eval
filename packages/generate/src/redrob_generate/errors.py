# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""Error types.

Every failure mode here is loud on purpose. The one thing this project cannot afford
is a verifier that fails to run and is counted as a pass.
"""

from __future__ import annotations


class RedrobGenerateError(Exception):
    """Base class for every error raised by this package."""


class SpecError(RedrobGenerateError):
    """A template, instance or manifest does not conform to the spec."""


class TemplateLoadError(SpecError):
    """A template could not be loaded or merged from disk."""


class ExpressionError(RedrobGenerateError):
    """A derivation expression is outside the restricted language, or failed to evaluate."""


class RenderError(RedrobGenerateError):
    """A prompt body or verifier binding could not be resolved."""


class SamplingError(RedrobGenerateError):
    """A parameter could not be sampled, for example because ``exclude`` rejected every draw."""


class UnsupportedVerifierError(RedrobGenerateError):
    """The verifier type is not supported by this implementation.

    Raised rather than skipped. A skipped verifier that reports success is the worst
    possible failure mode for a benchmark, so the unsupported path is an exception and
    the verdict path is an explicit failure with code ``unsupported_verifier``.
    """

    def __init__(self, verifier_type: str, reason: str = "") -> None:
        detail = f": {reason}" if reason else ""
        super().__init__(f"unsupported verifier type {verifier_type!r}{detail}")
        self.verifier_type = verifier_type
        self.reason = reason


class CanonicalJsonError(RedrobGenerateError):
    """A value cannot be canonicalised in a way another implementation would reproduce."""
