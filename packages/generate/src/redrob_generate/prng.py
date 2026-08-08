# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""SplitMix64, per spec section 3.1.

Chosen over the standard library RNG because it is eight lines of arithmetic that any
implementation in any language can reproduce exactly, with no dependence on a runtime's
internals. Determinism across versions is the whole point.
"""

from __future__ import annotations

MASK64 = (1 << 64) - 1
_GAMMA = 0x9E3779B97F4A7C15
_MIX1 = 0xBF58476D1CE4E5B9
_MIX2 = 0x94D049BB133111EB


class SplitMix64:
    """A single deterministic stream, consumed by parameters in declaration order."""

    __slots__ = ("_state",)

    def __init__(self, seed: int) -> None:
        self._state = seed & MASK64

    def next_u64(self) -> int:
        self._state = (self._state + _GAMMA) & MASK64
        z = self._state
        z = ((z ^ (z >> 30)) * _MIX1) & MASK64
        z = ((z ^ (z >> 27)) * _MIX2) & MASK64
        return (z ^ (z >> 31)) & MASK64

    def next_int(self, low: int, high: int) -> int:
        """Unbiased integer in ``[low, high]`` by rejection.

        Plain modulo would tilt the distribution toward small values for large ranges,
        which would be an invisible bias in every generated set.
        """
        if high < low:
            raise ValueError(f"empty range [{low}, {high}]")
        span = high - low + 1
        if span == 1:
            return low
        limit = (1 << 64) - ((1 << 64) % span)
        while True:
            drawn = self.next_u64()
            if drawn < limit:
                return low + (drawn % span)

    def next_unit_float(self) -> float:
        """A float in ``[0, 1)`` from the top 53 bits, which is exactly a double's mantissa."""
        return (self.next_u64() >> 11) / float(1 << 53)

    def next_bool(self) -> bool:
        return self.next_u64() & 1 == 1

    def shuffled_indices(self, count: int) -> list[int]:
        """Fisher-Yates over ``range(count)``, descending, as the spec pins it."""
        order = list(range(count))
        for i in range(count - 1, 0, -1):
            j = self.next_int(0, i)
            order[i], order[j] = order[j], order[i]
        return order
