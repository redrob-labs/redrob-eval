# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""Shared fixtures."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from redrob_generate.spec import find_spec_dir

REPO_ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture(scope="session")
def spec_dir() -> Path:
    return find_spec_dir()


@pytest.fixture(scope="session")
def conformance_dir(spec_dir: Path) -> Path:
    return spec_dir / "conformance"


@pytest.fixture(scope="session")
def templates_dir() -> Path:
    return REPO_ROOT / "templates"


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))
