# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""Proof that generation and declarative verification never touch the network.

Determinism cannot survive a dependency on something that can change or be unavailable,
so this is a property of the design rather than a nice-to-have. The test replaces the
socket constructor with one that raises, which fails the moment anything tries to open
a connection, resolve a name, or import a module that does either on the way in.
"""

from __future__ import annotations

import json
import socket
from pathlib import Path

import pytest

from redrob_generate.generate import build_instances
from redrob_generate.spec import find_spec_dir, load_template
from redrob_generate.verify import DECLARATIVE_VERIFIER_TYPES, run_verifier


class NetworkAccessDuringTest(AssertionError):
    """Raised if anything opens a socket while the guard is installed."""


@pytest.fixture
def no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    def forbidden(*args: object, **kwargs: object) -> None:
        raise NetworkAccessDuringTest(
            "a socket was opened during generation or declarative verification"
        )

    monkeypatch.setattr(socket, "socket", forbidden)
    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(socket, "getaddrinfo", forbidden)
    monkeypatch.setattr(socket, "gethostbyname", forbidden)


def test_the_guard_itself_works(no_network: None) -> None:
    """Without this, a broken guard would make every other test in the file vacuous."""
    with pytest.raises(NetworkAccessDuringTest):
        socket.socket()


@pytest.mark.parametrize(
    "relative",
    ["math/linear-equation", "extraction/quarterly-ledger", "format/release-note"],
)
def test_generation_opens_no_sockets(
    no_network: None, templates_dir: Path, relative: str
) -> None:
    template = load_template(templates_dir / relative)
    instances, _ = build_instances(template, 5)
    assert len(instances) == 5


def test_declarative_verification_opens_no_sockets(no_network: None) -> None:
    conformance_dir = find_spec_dir() / "conformance"
    checked = 0
    for path in sorted(conformance_dir.glob("*.json")):
        if path.stem not in DECLARATIVE_VERIFIER_TYPES:
            continue
        document = json.loads(path.read_text(encoding="utf-8"))
        for case in document["cases"]:
            verdict = run_verifier(case["verifier"], case["candidate"])
            assert verdict.passed == case["expected"]["passed"], case["id"]
            checked += 1
    assert checked > 100, "the suite got smaller, which would weaken this proof"


def test_json_schema_validation_does_not_fetch_remote_schemas(no_network: None) -> None:
    """The obvious way a JSON Schema validator reaches the network is a remote $ref.

    The subset check rejects those at configuration time, so the socket guard never even
    gets a chance to fire.
    """
    with pytest.raises(ValueError, match="local"):
        run_verifier(
            {"type": "json_schema", "schema": {"$ref": "https://json-schema.org/draft/2020-12/schema"}},
            "{}",
        )
