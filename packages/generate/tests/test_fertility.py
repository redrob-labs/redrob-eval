# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""The fertility hook, exercised with a trivial stub tokenizer.

No tokenizer is bundled and none is chosen, so the test supplies its own. The point of
the hook is comparability across locales: generated items carry identical semantic
content in every locale, so their token counts measure the tokenizer rather than the
corpus.
"""

from __future__ import annotations

from pathlib import Path

from redrob_generate.fertility import measure_instance, summarize
from redrob_generate.generate import build_instances
from redrob_generate.spec import load_template, validate_document


class WhitespaceTokenizer:
    """A stub. Splits on spaces, which is wrong for every real language and fine here."""

    name = "stub-whitespace"
    version = "0.0.1"

    def count_tokens(self, text: str) -> int:
        return len([piece for piece in text.split(" ") if piece])


class CharacterTokenizer:
    name = "stub-character"
    version = "0.0.1"

    def count_tokens(self, text: str) -> int:
        return len(text)


def test_measure_instance_records_the_tokenizer() -> None:
    record = measure_instance(WhitespaceTokenizer(), "one two three")
    assert record.tokenizer_name == "stub-whitespace"
    assert record.tokenizer_version == "0.0.1"
    assert record.prompt_tokens == 3
    assert record.prompt_characters == 13
    assert record.tokens_per_character == round(3 / 13, 6)


def test_empty_prompt_does_not_divide_by_zero() -> None:
    record = measure_instance(WhitespaceTokenizer(), "")
    assert record.prompt_tokens == 0
    assert record.tokens_per_character == 0.0


def test_character_tokenizer_has_a_ratio_of_one() -> None:
    record = measure_instance(CharacterTokenizer(), "\u0928\u092e\u0938\u094d\u0924\u0947")
    assert record.prompt_tokens == record.prompt_characters == 6
    assert record.tokens_per_character == 1.0


def test_instances_carry_fertility_when_a_tokenizer_is_supplied(templates_dir: Path) -> None:
    template = load_template(templates_dir / "math/linear-equation")
    instances, records = build_instances(template, 4, tokenizer=WhitespaceTokenizer())
    assert len(records) == 4
    for instance in instances:
        validate_document(instance, "instance")
        assert instance["fertility"]["tokenizer_name"] == "stub-whitespace"
        assert instance["fertility"]["prompt_tokens"] > 0


def test_instances_omit_fertility_by_default(templates_dir: Path) -> None:
    template = load_template(templates_dir / "math/linear-equation")
    instances, records = build_instances(template, 2)
    assert records == []
    assert all("fertility" not in instance for instance in instances)


def test_summary_rolls_up_for_the_manifest(templates_dir: Path) -> None:
    template = load_template(templates_dir / "math/linear-equation")
    tokenizer = WhitespaceTokenizer()
    _, records = build_instances(template, 6, tokenizer=tokenizer)
    summary = summarize(tokenizer, records)
    validate_document(summary, "manifest_fertility")
    assert summary["instances_measured"] == 6
    assert summary["total_prompt_tokens"] == sum(record.prompt_tokens for record in records)
    assert summary["mean_tokens_per_character"] == round(
        summary["total_prompt_tokens"] / summary["total_prompt_characters"], 6
    )


def test_counts_are_comparable_across_tokenizers_for_identical_content(
    templates_dir: Path,
) -> None:
    """The comparability claim, in its simplest form.

    The same instance measured by two tokenizers differs only by the tokenizer, because
    the content is fixed by the seed. That is the property that makes a cross-locale
    comparison meaningful once non-English locale layers exist.
    """
    template = load_template(templates_dir / "math/linear-equation")
    instances, _ = build_instances(template, 1)
    prompt = instances[0]["prompt"]
    whitespace = measure_instance(WhitespaceTokenizer(), prompt)
    characters = measure_instance(CharacterTokenizer(), prompt)
    assert whitespace.prompt_characters == characters.prompt_characters
    assert whitespace.prompt_tokens < characters.prompt_tokens
