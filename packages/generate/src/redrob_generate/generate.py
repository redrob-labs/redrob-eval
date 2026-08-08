# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""Instance generation: seed, sample, derive, render, bind.

Nothing in this path reads the clock, the environment or the network. Two runs with the
same template and count produce byte-identical instances, which is the property the rest
of the design depends on.
"""

from __future__ import annotations

from typing import Any, Mapping

from .__about__ import GENERATOR_VERSION, SPEC_VERSION
from .expr import evaluate_derivations
from .fertility import FertilityRecord, Tokenizer, measure_instance
from .render import render_prompt, resolve_bindings
from .sample import sample_parameters
from .seed import derive_seed, seed_to_string
from .spec import template_content_hash, validate_document


def build_instance(
    template: Mapping[str, Any],
    instance_index: int,
    *,
    template_hash: str | None = None,
    generator_version: str = GENERATOR_VERSION,
    tokenizer: Tokenizer | None = None,
) -> tuple[dict[str, Any], FertilityRecord | None]:
    """Produce one instance and, when a tokenizer is supplied, its fertility record."""
    template_id = template["id"]
    seed = derive_seed(template_id, instance_index, generator_version)
    parameters = sample_parameters(template, seed)
    derived = evaluate_derivations(list(template.get("derivations", [])), parameters)

    scope: dict[str, Any] = {**parameters, **derived}
    prompt = render_prompt(template["prompt"], scope)
    verifier = resolve_bindings(template["verifier"], scope)

    instance: dict[str, Any] = {
        "spec_version": SPEC_VERSION,
        "template_id": template_id,
        "template_version": template["version"],
        "template_hash": template_hash or template_content_hash(dict(template)),
        "locale": template["locale"],
        "instance_index": instance_index,
        "seed": seed_to_string(seed),
        "parameters": parameters,
        "prompt": prompt,
        "verifier": verifier,
    }
    if derived:
        instance["derived"] = derived

    record: FertilityRecord | None = None
    if tokenizer is not None:
        record = measure_instance(tokenizer, prompt)
        instance["fertility"] = record.to_dict()

    validate_document(instance, "instance")
    validate_document(verifier, "verifier")
    return instance, record


def build_instances(
    template: Mapping[str, Any],
    count: int,
    *,
    generator_version: str = GENERATOR_VERSION,
    tokenizer: Tokenizer | None = None,
) -> tuple[list[dict[str, Any]], list[FertilityRecord]]:
    """Produce ``count`` instances of one template, indexed from zero."""
    if count < 0:
        raise ValueError(f"count must be non-negative, got {count}")
    template_hash = template_content_hash(dict(template))
    instances: list[dict[str, Any]] = []
    records: list[FertilityRecord] = []
    for index in range(count):
        instance, record = build_instance(
            template,
            index,
            template_hash=template_hash,
            generator_version=generator_version,
            tokenizer=tokenizer,
        )
        instances.append(instance)
        if record is not None:
            records.append(record)
    return instances, records
