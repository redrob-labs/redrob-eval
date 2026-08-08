# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""Seed derivation, the PRNG and parameter sampling."""

from __future__ import annotations

import hashlib
from collections import Counter

import pytest

from redrob_generate.prng import SplitMix64
from redrob_generate.sample import _round_half_away_from_zero, sample_parameters
from redrob_generate.seed import derive_seed, seed_message, seed_to_string


def test_seed_message_layout() -> None:
    """The NUL separators are what make the encoding unambiguous, so they are pinned."""
    assert seed_message("0.1.0", "math.linear_equation", 0) == (
        b"0.1.0\x00math.linear_equation\x000"
    )


def test_seed_matches_a_hand_computed_digest() -> None:
    message = b"0.1.0\x00math.linear_equation\x007"
    expected = int.from_bytes(hashlib.sha256(message).digest()[:8], "big")
    assert derive_seed("math.linear_equation", 7, "0.1.0") == expected


def test_seed_depends_on_every_input() -> None:
    base = derive_seed("t", 0, "0.1.0")
    assert derive_seed("t", 1, "0.1.0") != base
    assert derive_seed("u", 0, "0.1.0") != base
    assert derive_seed("t", 0, "0.2.0") != base


def test_separator_prevents_field_boundary_collisions() -> None:
    """Without the NUL bytes, ("ab", "c") and ("a", "bc") would hash identically."""
    assert seed_message("0.1.0", "ab", 1) != seed_message("0.1.0", "a", 1)
    assert derive_seed("ab", 1, "0.1.0") != derive_seed("a", 1, "0.1.0")


def test_seed_is_a_uint64() -> None:
    for index in range(200):
        seed = derive_seed("math.linear_equation", index)
        assert 0 <= seed < 2**64


def test_negative_index_is_rejected() -> None:
    with pytest.raises(ValueError):
        derive_seed("t", -1)


def test_seed_is_serialised_as_a_decimal_string() -> None:
    """A uint64 does not survive a double, so JSON carries the decimal string."""
    seed = 18446744073709551615
    assert seed_to_string(seed) == "18446744073709551615"
    assert int(float(seed)) != seed


def test_splitmix64_is_reproducible() -> None:
    first = [SplitMix64(12345).next_u64() for _ in range(8)]
    second = [SplitMix64(12345).next_u64() for _ in range(8)]
    assert first == second
    assert all(0 <= value < 2**64 for value in first)


def test_splitmix64_reference_vector() -> None:
    """SplitMix64 output for state 0, cross-checked against an independent transcription
    of Vigna's reference splitmix64.c written in JavaScript BigInt arithmetic.

    The point of pinning it is the three magic constants: a typo in any of them still
    produces plausible-looking random numbers.
    """
    rng = SplitMix64(0)
    assert [rng.next_u64() for _ in range(3)] == [
        16294208416658607535,
        7960286522194355700,
        487617019471545679,
    ]


def test_next_int_stays_in_range_and_covers_it() -> None:
    rng = SplitMix64(99)
    counts = Counter(rng.next_int(3, 7) for _ in range(4000))
    assert set(counts) == {3, 4, 5, 6, 7}
    # Rejection sampling, so no value should be dramatically over-represented.
    assert max(counts.values()) < 2 * min(counts.values())


def test_next_int_single_value_range() -> None:
    assert SplitMix64(1).next_int(5, 5) == 5


def test_unit_float_is_in_the_half_open_unit_interval() -> None:
    rng = SplitMix64(7)
    values = [rng.next_unit_float() for _ in range(1000)]
    assert all(0.0 <= value < 1.0 for value in values)


def test_shuffle_is_a_permutation() -> None:
    order = SplitMix64(2024).shuffled_indices(12)
    assert sorted(order) == list(range(12))


@pytest.mark.parametrize(
    "value,decimals,expected",
    [
        (2.5, 0, 3.0),
        (-2.5, 0, -3.0),
        (1.005, 2, 1.0),
        (0.125, 2, 0.13),
        (-0.125, 2, -0.13),
    ],
)
def test_rounding_is_half_away_from_zero(value: float, decimals: int, expected: float) -> None:
    """Python's round() is banker's rounding, so the spec spells the rule out instead.

    1.005 rounds to 1.0 because the nearest double to 1.005 is just below it; that is
    a property of binary floating point, not of the rounding rule.
    """
    assert _round_half_away_from_zero(value, decimals) == expected


def _template(parameters: list[dict]) -> dict:
    return {"id": "t.test", "parameters": parameters}


def test_sampling_is_deterministic_for_a_seed() -> None:
    template = _template(
        [
            {"name": "a", "type": "integer", "min": 1, "max": 100},
            {"name": "b", "type": "number", "min": 0, "max": 1, "decimals": 4},
            {"name": "c", "type": "boolean"},
            {"name": "d", "type": "choice", "choices": ["x", "y", "z"]},
        ]
    )
    assert sample_parameters(template, 4242) == sample_parameters(template, 4242)
    assert sample_parameters(template, 4242) != sample_parameters(template, 4243)


def test_declaration_order_is_load_bearing() -> None:
    """Reordering parameters changes the draw order and therefore the generated set."""
    first = _template(
        [
            {"name": "a", "type": "integer", "min": 0, "max": 1000},
            {"name": "b", "type": "integer", "min": 0, "max": 1000},
        ]
    )
    second = _template(list(reversed(first["parameters"])))
    assert sample_parameters(first, 5) != sample_parameters(second, 5)


def test_exclude_is_respected() -> None:
    template = _template(
        [{"name": "a", "type": "integer", "min": 0, "max": 3, "exclude": [0, 1, 2]}]
    )
    for seed in range(50):
        assert sample_parameters(template, seed)["a"] == 3


def test_exclude_that_rejects_everything_fails_loudly() -> None:
    from redrob_generate.errors import SamplingError

    template = _template([{"name": "a", "type": "integer", "min": 0, "max": 1, "exclude": [0, 1]}])
    with pytest.raises(SamplingError):
        sample_parameters(template, 1)


def test_subset_is_sorted_by_original_index() -> None:
    choices = ["a", "b", "c", "d", "e", "f"]
    template = _template([{"name": "s", "type": "subset", "choices": choices, "size": 3}])
    for seed in range(30):
        drawn = sample_parameters(template, seed)["s"]
        assert len(drawn) == 3
        assert len(set(drawn)) == 3
        assert [choices.index(item) for item in drawn] == sorted(
            choices.index(item) for item in drawn
        )


def test_permutation_keeps_every_element() -> None:
    choices = [1, 2, 3, 4, 5]
    template = _template([{"name": "p", "type": "permutation", "choices": choices}])
    drawn = sample_parameters(template, 11)["p"]
    assert sorted(drawn) == choices


def test_number_respects_bounds_and_decimals() -> None:
    template = _template([{"name": "n", "type": "number", "min": -2, "max": 2, "decimals": 2}])
    for seed in range(200):
        value = sample_parameters(template, seed)["n"]
        assert -2 <= value <= 2
        assert round(value, 2) == value
