# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""Fertility measurement hook, per spec section 8.

Why this is worth a hook rather than a downstream script: because generated items carry
identical semantic content across locales, their token counts are directly comparable.
Corpus-level fertility statistics are not, because they conflate the tokenizer with
whatever the corpus happens to talk about. Here the parameters, the seed and the
expected answer are identical across locales by construction, and only the surface
wording differs, so the ratio between two locales' counts measures the tokenizer rather
than the corpus.

No tokenizer is bundled and none is chosen. This module is the interface; the caller
supplies the implementation and the run records which one it was.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Protocol, runtime_checkable


@runtime_checkable
class Tokenizer(Protocol):
    """The whole contract a tokenizer must satisfy to be usable here."""

    name: str
    version: str

    def count_tokens(self, text: str) -> int: ...


@dataclass(frozen=True)
class FertilityRecord:
    tokenizer_name: str
    tokenizer_version: str
    prompt_tokens: int
    prompt_characters: int
    tokens_per_character: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "tokenizer_name": self.tokenizer_name,
            "tokenizer_version": self.tokenizer_version,
            "prompt_tokens": self.prompt_tokens,
            "prompt_characters": self.prompt_characters,
            "tokens_per_character": self.tokens_per_character,
        }


# Rounded because an unrounded ratio is a float with a long tail, and canonical JSON
# refuses floats whose shortest representation differs between Python and JavaScript.
RATIO_DECIMALS = 6


def measure_instance(tokenizer: Tokenizer, prompt: str) -> FertilityRecord:
    """Token counts for one rendered prompt."""
    tokens = int(tokenizer.count_tokens(prompt))
    characters = len(prompt)
    ratio = round(tokens / characters, RATIO_DECIMALS) if characters else 0.0
    return FertilityRecord(
        tokenizer_name=tokenizer.name,
        tokenizer_version=tokenizer.version,
        prompt_tokens=tokens,
        prompt_characters=characters,
        tokens_per_character=ratio,
    )


def summarize(tokenizer: Tokenizer, records: Iterable[FertilityRecord]) -> dict[str, Any]:
    """The manifest-level rollup for a whole generated set."""
    materialised = list(records)
    total_tokens = sum(record.prompt_tokens for record in materialised)
    total_characters = sum(record.prompt_characters for record in materialised)
    mean = round(total_tokens / total_characters, RATIO_DECIMALS) if total_characters else 0.0
    return {
        "tokenizer_name": tokenizer.name,
        "tokenizer_version": tokenizer.version,
        "instances_measured": len(materialised),
        "total_prompt_tokens": total_tokens,
        "total_prompt_characters": total_characters,
        "mean_tokens_per_character": mean,
    }
