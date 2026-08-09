# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""Building the results artifact and its aggregates.

Numbers only. There is no field here for a conclusion and no code that writes one,
because an artifact carrying a sentence about what its numbers mean is the sentence that
gets quoted.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping, Sequence

from ..__about__ import GENERATOR_NAME, GENERATOR_VERSION, SPEC_VERSION
from ..provenance import local_provenance
from .config import STUDY_VERSION, StudyConfig, validate_study_document
from .runner import Scored

#: Decimal places for every derived float. Canonical JSON refuses a float whose shortest
#: representation differs between Python and JavaScript, and an unrounded mean has a long
#: tail that can land there. Six is far beyond the precision any of these numbers carry.
ROUND = 6


def _mean(values: Sequence[float]) -> float:
    return round(sum(values) / len(values), ROUND) if values else 0.0


def accuracy_rows(scored: Iterable[Scored]) -> list[dict[str, Any]]:
    """Pass rate per model, locale and verifier family."""
    buckets: dict[tuple[str, str, str], list[bool]] = {}
    for row in scored:
        buckets.setdefault((row.model_id, row.locale, row.verifier_family), []).append(row.passed)
    rows = []
    for (model_id, locale, family), results in buckets.items():
        passed = sum(1 for value in results if value)
        rows.append(
            {
                "model_id": model_id,
                "locale": locale,
                "verifier_family": family,
                "n": len(results),
                "passed": passed,
                "accuracy": round(passed / len(results), ROUND) if results else 0.0,
            }
        )
    return sorted(rows, key=lambda row: (row["model_id"], row["locale"], row["verifier_family"]))


def token_rows(scored: Iterable[Scored]) -> list[dict[str, Any]]:
    """Mean prompt tokens per locale.

    Deduplicated by (template, instance) before averaging: the same prompt is scored
    once per model, and counting it once per model would weight a locale by how many
    models happened to be under test rather than by its prompts.
    """
    seen: dict[str, dict[tuple[str, int], int]] = {}
    for row in scored:
        seen.setdefault(row.locale, {})[(row.template_id, row.instance_index)] = row.prompt_tokens
    rows = []
    for locale in sorted(seen):
        counts = list(seen[locale].values())
        rows.append(
            {
                "locale": locale,
                "n": len(counts),
                "mean_prompt_tokens": _mean([float(value) for value in counts]),
            }
        )
    return rows


def paired_deltas(
    scored: Iterable[Scored],
    comparisons: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Differences between two locales over items matched on template and index.

    Pairing is the whole point. Seeds carry no locale term, so instance 3 of a template
    is the same item in both locales and the only thing that differs is the wording. An
    unpaired difference of means over the two sets would answer a weaker question and
    would be sensitive to one locale happening to have more instances.
    """
    rows = []
    by_key: dict[tuple[str, str, str, int], Scored] = {}
    for row in scored:
        by_key[(row.locale, row.model_id, row.template_id, row.instance_index)] = row

    for comparison in comparisons:
        left_tag, right_tag = comparison["left"], comparison["right"]
        token_pairs: list[tuple[int, int]] = []
        accuracy_pairs: list[tuple[bool, bool]] = []
        dropped = 0
        seen_tokens: set[tuple[str, int]] = set()

        for (locale, model_id, template_id, index), row in sorted(
            by_key.items(), key=lambda item: item[0]
        ):
            if locale != left_tag:
                continue
            partner = by_key.get((right_tag, model_id, template_id, index))
            if partner is None:
                dropped += 1
                continue
            accuracy_pairs.append((row.passed, partner.passed))
            # Prompt token counts do not vary by model, so a pair is counted once per
            # item rather than once per model.
            if (template_id, index) not in seen_tokens:
                seen_tokens.add((template_id, index))
                token_pairs.append((row.prompt_tokens, partner.prompt_tokens))

        left_tokens = [float(pair[0]) for pair in token_pairs]
        right_tokens = [float(pair[1]) for pair in token_pairs]
        deltas = [float(pair[1] - pair[0]) for pair in token_pairs]
        left_acc = [1.0 if pair[0] else 0.0 for pair in accuracy_pairs]
        right_acc = [1.0 if pair[1] else 0.0 for pair in accuracy_pairs]

        rows.append(
            {
                "comparison": comparison["id"],
                "left": left_tag,
                "right": right_tag,
                "n_pairs": len(accuracy_pairs),
                "dropped_unpaired": dropped,
                "mean_prompt_tokens_left": _mean(left_tokens),
                "mean_prompt_tokens_right": _mean(right_tokens),
                "mean_prompt_tokens_delta": _mean(deltas),
                "accuracy_left": _mean(left_acc),
                "accuracy_right": _mean(right_acc),
                "accuracy_delta": round(_mean(right_acc) - _mean(left_acc), ROUND),
            }
        )
    return rows


def instance_rows(scored: Iterable[Scored]) -> list[dict[str, Any]]:
    """Per-instance records, each carrying the provenance of its own verdict."""
    provenance = local_provenance()
    rows = []
    for row in scored:
        record: dict[str, Any] = {
            "model_id": row.model_id,
            "template_id": row.template_id,
            "locale": row.locale,
            "instance_index": row.instance_index,
            "seed": row.seed,
            "verifier_family": row.verifier_family,
            "passed": row.passed,
            "code": row.code,
            "verdict_provenance": dict(provenance),
            "prompt_tokens": row.prompt_tokens,
            "code_mix_ratio": row.code_mix_ratio,
        }
        if row.elements is not None:
            record["elements"] = [dict(element) for element in row.elements]
        rows.append(record)
    return sorted(
        rows,
        key=lambda row: (
            row["model_id"],
            row["locale"],
            row["template_id"],
            row["instance_index"],
        ),
    )


def build_result(
    config: StudyConfig,
    scored: Sequence[Scored],
    locale_records: Sequence[Mapping[str, Any]],
    *,
    created_at: str,
    peer_runtime: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Assemble and validate the artifact.

    ``peer_runtime`` is the other implementation's record. It is included even though it
    produced none of these verdicts, because the reason Python is normative is that the
    two runtimes read different Unicode tables, and a reader cannot check that claim
    unless both versions are in front of them.
    """
    runtimes = [local_provenance()]
    if peer_runtime is not None:
        runtimes.append(dict(peer_runtime))

    result = {
        "study_version": STUDY_VERSION,
        "study_id": config.id,
        "provenance": {
            "generator_name": GENERATOR_NAME,
            "generator_version": GENERATOR_VERSION,
            "spec_version": SPEC_VERSION,
            "seed_policy": config.seed_policy,
            "tokenizer": config.tokenizer,
            "runtimes": runtimes,
            "models": [dict(model) for model in config.models],
            "created_at": created_at,
        },
        "locales": [dict(record) for record in locale_records],
        "instances": instance_rows(scored),
        "aggregates": {
            "accuracy": accuracy_rows(scored),
            "tokens": token_rows(scored),
            "paired_deltas": paired_deltas(scored, config.comparisons),
        },
    }
    validate_study_document(result, "study_result")
    return result
