# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""Model invocation for a study run.

Two clients implement one protocol. :class:`HarnessModelClient` shells out to the
TypeScript harness so that a study reaches models through exactly the same
``callModel()`` the Compare module uses -- there is no second HTTP client here, no
second retry policy and no second place for a provider quirk to be handled differently.
:class:`MockModelClient` answers in process from the instance itself, so the whole
pipeline can be exercised with no network, no keys and no spend.

The mock is not a stub that returns a constant. It synthesises an answer the verifier
will actually accept, which means a mock run produces a non-degenerate accuracy number
and the aggregation and delta code is exercised on values that are not all zero.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Protocol, Sequence

from ..canonical import canonical_json
from ..errors import RedrobGenerateError


class ModelInvocationError(RedrobGenerateError):
    """A model could not be reached, or answered with something unusable."""


@dataclass(frozen=True)
class ModelResponse:
    text: str
    model_id: str
    #: Where the answer came from. Recorded so a mock run can never be mistaken for a
    #: real one by reading the artifact.
    provider: str


class ModelClient(Protocol):
    provider: str

    def complete(self, *, model_id: str, prompt: str, instance: Mapping[str, Any]) -> ModelResponse:
        ...


# --------------------------------------------------------------------------- mock


#: Answer used when the mock is meant to be wrong, and when it cannot work out how to be
#: right. It is deliberately not empty and not plausible: an empty string would pass a
#: verifier that only checks a maximum length, and a plausible one would make a failure
#: hard to spot when reading the artifact by eye.
WRONG_ANSWER = "MOCK-INCORRECT-ANSWER"


def _numeric_answer(config: Mapping[str, Any]) -> str | None:
    expected = config.get("expected")
    if isinstance(expected, bool) or not isinstance(expected, (int, float, str)):
        return None
    return str(expected)


def synthesize_passing_answer(verifier: Any, instance: Mapping[str, Any]) -> str | None:
    """An answer the verifier accepts, or ``None`` when it cannot be inverted.

    Only the verifiers whose configuration literally contains the answer are inverted:
    ``exact`` and the equality pair carry it, ``numeric_tolerance`` carries a value
    within tolerance of itself. ``regex``, ``json_schema`` and ``format_constraint``
    describe a set of acceptable answers rather than naming one, and constructing a
    member of that set is a search problem this mock deliberately does not attempt.

    For a verifier list, the answer must satisfy every element, so the elements are
    tried in order and the first invertible one wins -- then the caller finds out
    whether that guess satisfied the others by running the real verifier over it. No
    answer is assumed to pass; every mock answer is scored exactly like a real one.
    """
    if isinstance(verifier, (list, tuple)):
        for element in verifier:
            answer = synthesize_passing_answer(element, instance)
            if answer is not None:
                return answer
        return None
    if not isinstance(verifier, Mapping):
        return None

    kind = verifier.get("type")
    if kind == "exact":
        expected = verifier.get("expected")
        return expected if isinstance(expected, str) else None
    if kind == "numeric_tolerance":
        return _numeric_answer(verifier)
    if kind in ("set_equality", "ordered_equality"):
        expected = verifier.get("expected")
        if not isinstance(expected, Sequence) or isinstance(expected, str):
            return None
        parse = verifier.get("parse", {})
        delimiter = parse.get("delimiter") if isinstance(parse, Mapping) else None
        if not isinstance(delimiter, str) or delimiter == "":
            return None
        rendered = []
        for item in expected:
            if isinstance(item, str):
                rendered.append(item)
            elif isinstance(item, (int, float)) and not isinstance(item, bool):
                rendered.append(str(item))
            else:
                return None
        return delimiter.join(rendered)
    return None


class MockModelClient:
    """A model that answers from the instance, deterministically and offline."""

    provider = "mock"

    def __init__(self, strategy: str) -> None:
        if strategy not in ("expected", "wrong", "alternating"):
            raise ValueError(f"unknown mock strategy {strategy!r}")
        self.strategy = strategy

    def _should_try(self, model_id: str, instance: Mapping[str, Any]) -> bool:
        if self.strategy == "expected":
            return True
        if self.strategy == "wrong":
            return False
        # Alternating on a hash rather than on index parity, so that the pattern is not
        # aligned across templates and locales. It stays a pure function of the inputs,
        # so reruns are identical.
        digest = hashlib.sha256(
            "\x00".join(
                [
                    model_id,
                    str(instance.get("template_id")),
                    str(instance.get("instance_index")),
                ]
            ).encode("utf-8")
        ).digest()
        return digest[0] % 2 == 0

    def complete(self, *, model_id: str, prompt: str, instance: Mapping[str, Any]) -> ModelResponse:
        text = WRONG_ANSWER
        if self._should_try(model_id, instance):
            answer = synthesize_passing_answer(instance.get("verifier"), instance)
            if answer is not None:
                text = answer
        return ModelResponse(text=text, model_id=model_id, provider=self.provider)


# ------------------------------------------------------------------------ harness


#: Path of the bridge script relative to the repository root.
BRIDGE_SCRIPT = Path("scripts") / "study-model-call.mts"
DEFAULT_TIMEOUT_S = 120


def _repo_root() -> Path:
    """Nearest ancestor holding the bridge script."""
    for ancestor in Path(__file__).resolve().parents:
        if (ancestor / BRIDGE_SCRIPT).is_file():
            return ancestor
    raise ModelInvocationError(
        f"could not locate {BRIDGE_SCRIPT}; the harness provider needs the repository "
        "checkout, so use the mock provider outside it"
    )


class HarnessModelClient:
    """Calls models through the TypeScript harness's ``callModel``.

    This is a subprocess rather than a port of the provider adapters. The adapters
    already hold the retry policy, the per-provider request shapes and the key handling,
    and a second copy in Python would be a second thing to keep correct.
    """

    provider = "harness"

    def __init__(self, *, timeout_s: int = DEFAULT_TIMEOUT_S, root: Path | None = None) -> None:
        self.timeout_s = timeout_s
        self.root = root or _repo_root()

    def complete(self, *, model_id: str, prompt: str, instance: Mapping[str, Any]) -> ModelResponse:
        payload = canonical_json({"model_id": model_id, "prompt": prompt})
        command = ["node", "--import", "tsx", str(BRIDGE_SCRIPT)]
        try:
            completed = subprocess.run(
                command,
                input=payload,
                capture_output=True,
                text=True,
                timeout=self.timeout_s,
                cwd=self.root,
                env={**os.environ},
                check=False,
            )
        except FileNotFoundError as exc:
            raise ModelInvocationError(
                "node is not on PATH, so the harness provider cannot run; the mock "
                "provider needs neither node nor network"
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise ModelInvocationError(
                f"model call for {model_id!r} timed out after {self.timeout_s}s"
            ) from exc

        if completed.returncode != 0:
            raise ModelInvocationError(
                f"model call for {model_id!r} failed ({completed.returncode}): "
                f"{completed.stderr.strip()[:500]}"
            )
        try:
            parsed = json.loads(completed.stdout)
        except ValueError as exc:
            raise ModelInvocationError(
                f"model bridge returned non-JSON for {model_id!r}: "
                f"{completed.stdout.strip()[:200]}"
            ) from exc
        if not isinstance(parsed, dict) or not isinstance(parsed.get("text"), str):
            raise ModelInvocationError(
                f"model bridge returned no text for {model_id!r}: {parsed!r}"
            )
        return ModelResponse(text=parsed["text"], model_id=model_id, provider=self.provider)


def build_client(model: Mapping[str, Any]) -> ModelClient:
    """The client one config entry asks for."""
    provider = model["provider"]
    if provider == "mock":
        return MockModelClient(model["mock_strategy"])
    if provider == "harness":
        return HarnessModelClient()
    # Unreachable through a validated config; kept so that widening the schema's
    # provider enum without widening this function fails loudly rather than silently
    # falling through to the mock.
    raise ModelInvocationError(f"unknown provider {provider!r}")
