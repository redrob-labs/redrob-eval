# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""Seed derivation, per spec section 2.

    seed = uint64_be(sha256(generator_version || 0x00 || template_id || 0x00 || instance_index)[0:8])

A fixed conventional seed such as 42 makes seed selection unverifiable: a reader cannot
tell one honest run from the best of several. A content-derived seed is recomputable by
any third party from the published generator version and template id, which makes
cherry-picking structurally impossible rather than merely discouraged.
"""

from __future__ import annotations

import hashlib

from .__about__ import GENERATOR_VERSION

SEED_METHOD = "sha256-prefix-uint64-be"
SEED_FORMULA = (
    'uint64_be(sha256(generator_version || "\\x00" || template_id || "\\x00" || instance_index)[0:8])'
)
SEED_INPUTS = ["generator_version", "template_id", "instance_index"]

_SEPARATOR = b"\x00"


def seed_message(generator_version: str, template_id: str, instance_index: int) -> bytes:
    """The exact byte string that gets hashed. Exposed so tests can check it by hand."""
    if instance_index < 0:
        raise ValueError(f"instance_index must be non-negative, got {instance_index}")
    return (
        generator_version.encode("utf-8")
        + _SEPARATOR
        + template_id.encode("utf-8")
        + _SEPARATOR
        + str(instance_index).encode("utf-8")
    )


def derive_seed(
    template_id: str,
    instance_index: int,
    generator_version: str = GENERATOR_VERSION,
) -> int:
    """Derive the uint64 seed for one instance of one template."""
    digest = hashlib.sha256(seed_message(generator_version, template_id, instance_index)).digest()
    return int.from_bytes(digest[:8], byteorder="big", signed=False)


def seed_to_string(seed: int) -> str:
    """Render a seed for JSON.

    Decimal string, because a uint64 does not survive a round trip through a double and
    the TypeScript reader would silently receive a different number.
    """
    return str(seed)
