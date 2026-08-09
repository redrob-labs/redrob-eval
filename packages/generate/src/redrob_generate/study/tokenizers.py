# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""Offline token counting schemes for a study run.

None of these is a model's tokenizer, and the naming is meant to make that impossible to
miss. A real fertility measurement needs the tokenizer of the model under test, which
means downloading its vocabulary, which means network -- and the study pipeline has to
be runnable and testable with none. So what ships here is a small set of schemes that
are well defined, deterministic, dependency-free and honest about being proxies.

``utf8_bytes`` is the closest of the three to the quantity the study is about. A
Devanagari or Hangul code point costs three UTF-8 bytes where ASCII costs one, and most
subword vocabularies are built over byte sequences, so byte count moves in the same
direction as real fertility even though it is not equal to it. ``codepoints`` moves in
the *opposite* direction for these scripts, since Hangul packs a syllable into one code
point, and it is included precisely so that the difference between a plausible proxy and
a misleading one is visible in the artifact rather than argued about.

Which one a run used is recorded per instance and in the artifact, so no number here can
be mistaken for a measurement under a model's own tokenizer.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from ..errors import RedrobGenerateError
from ..verify.base import SPEC_WHITESPACE

_WHITESPACE_RUN = re.compile(f"[{re.escape(SPEC_WHITESPACE)}]+")


class UnknownTokenizerError(RedrobGenerateError):
    """The config named a token counting scheme that does not exist."""


@dataclass(frozen=True)
class BuiltinTokenizer:
    """Satisfies the :class:`redrob_generate.fertility.Tokenizer` protocol."""

    name: str
    version: str
    scheme: str

    def count_tokens(self, text: str) -> int:
        if self.scheme == "utf8_bytes":
            return len(text.encode("utf-8"))
        if self.scheme == "codepoints":
            return len(text)
        if self.scheme == "whitespace_words":
            stripped = _WHITESPACE_RUN.sub(" ", text).strip(" ")
            return 0 if stripped == "" else len(stripped.split(" "))
        raise UnknownTokenizerError(f"unknown scheme {self.scheme!r}")


#: Every scheme, by the name a config uses. Versioned independently of the package: a
#: change to how one of these counts is a change to what a published number means, so it
#: has to be visible as a version bump in the artifact rather than hidden in a release.
BUILTIN_TOKENIZERS = {
    "builtin/utf8-bytes": BuiltinTokenizer("builtin/utf8-bytes", "1", "utf8_bytes"),
    "builtin/codepoints": BuiltinTokenizer("builtin/codepoints", "1", "codepoints"),
    "builtin/whitespace-words": BuiltinTokenizer("builtin/whitespace-words", "1", "whitespace_words"),
}


def resolve_tokenizer(name: str, version: str) -> BuiltinTokenizer:
    """The tokenizer a config asks for, or a clear refusal."""
    tokenizer = BUILTIN_TOKENIZERS.get(name)
    if tokenizer is None:
        raise UnknownTokenizerError(
            f"unknown tokenizer {name!r}; available schemes are "
            f"{sorted(BUILTIN_TOKENIZERS)}. These are offline proxies, not model "
            "tokenizers; measuring fertility under a model's own vocabulary needs a "
            "download and is not wired up here"
        )
    if tokenizer.version != version:
        raise UnknownTokenizerError(
            f"tokenizer {name!r} is version {tokenizer.version!r} here but the config "
            f"asks for {version!r}; a token count is only comparable within one version"
        )
    return tokenizer
