# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""Deterministic parameter sampling, per spec section 3.

One SplitMix64 stream per instance, consumed by parameters in declaration order.
Reordering the ``parameters`` array therefore changes the generated set, which is why
a template edit also changes its content hash.
"""

from __future__ import annotations

import math
from typing import Any, Mapping, Sequence

from .errors import SamplingError
from .prng import SplitMix64

MAX_EXCLUSION_ATTEMPTS = 1000


def _round_half_away_from_zero(value: float, decimals: int) -> float:
    """Explicit rounding, because language built-ins disagree about halves.

    Python's ``round`` is banker's rounding and JavaScript's ``Math.round`` breaks ties
    upward even for negatives. Neither is what the spec says, so it is written out.
    """
    factor = 10**decimals
    scaled = value * factor
    rounded = math.floor(scaled + 0.5) if scaled >= 0 else math.ceil(scaled - 0.5)
    return rounded / factor


def _draw_one(rng: SplitMix64, parameter: Mapping[str, Any]) -> Any:
    kind = parameter["type"]
    if kind == "integer":
        return rng.next_int(int(parameter["min"]), int(parameter["max"]))
    if kind == "number":
        low = float(parameter["min"])
        high = float(parameter["max"])
        value = low + rng.next_unit_float() * (high - low)
        decimals = parameter.get("decimals")
        if decimals is not None:
            value = _round_half_away_from_zero(value, int(decimals))
        return value
    if kind == "boolean":
        return rng.next_bool()
    if kind == "choice":
        choices: Sequence[Any] = parameter["choices"]
        return choices[rng.next_int(0, len(choices) - 1)]
    if kind == "subset":
        choices = parameter["choices"]
        size = int(parameter["size"])
        order = rng.shuffled_indices(len(choices))
        picked = sorted(order[:size])
        return [choices[index] for index in picked]
    if kind == "permutation":
        choices = parameter["choices"]
        return [choices[index] for index in rng.shuffled_indices(len(choices))]
    raise SamplingError(f"unknown parameter type {kind!r}")  # pragma: no cover - schema-validated


def sample_parameters(template: Mapping[str, Any], seed: int) -> dict[str, Any]:
    """Bind every declared parameter for one instance."""
    rng = SplitMix64(seed)
    bound: dict[str, Any] = {}
    for parameter in template["parameters"]:
        excluded = parameter.get("exclude", [])
        for attempt in range(MAX_EXCLUSION_ATTEMPTS):
            value = _draw_one(rng, parameter)
            if value not in excluded:
                break
        else:
            raise SamplingError(
                f"parameter {parameter['name']!r} could not be sampled in "
                f"{MAX_EXCLUSION_ATTEMPTS} attempts; its exclude list rejects too much of "
                "its range"
            )
        bound[parameter["name"]] = value
    return bound
