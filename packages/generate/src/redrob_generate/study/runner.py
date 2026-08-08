# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""Orchestration: generate per locale, ask each model, score with Python."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Mapping

from ..errors import SpecError
from ..fertility import Tokenizer
from ..generate import build_instances
from ..provenance import local_provenance
from ..spec import load_template
from ..verify import run_verifier
from .config import StudyConfig
from .models import ModelClient, build_client


@dataclass(frozen=True)
class Scored:
    """One model's answer to one instance, scored."""

    model_id: str
    template_id: str
    locale: str
    instance_index: int
    seed: str
    verifier_family: str
    passed: bool
    code: str
    elements: list[dict[str, Any]] | None
    prompt_tokens: int
    code_mix_ratio: float | None


def verifier_family(verifier: Any) -> str:
    """Label used to group results. A list is named by its element types, in order."""
    if isinstance(verifier, list):
        return "[" + ", ".join(str(element.get("type")) for element in verifier) + "]"
    if isinstance(verifier, Mapping):
        return str(verifier.get("type"))
    return "unknown"


def run_study(
    config: StudyConfig,
    tokenizer: Tokenizer,
    *,
    client_factory: Callable[[Mapping[str, Any]], ModelClient] = build_client,
) -> tuple[list[Scored], list[dict[str, Any]]]:
    """Run every (template, locale, instance, model) cell.

    Returns the scored rows and the locale records, the latter carrying the translation
    status actually found on disk rather than the one the config hoped for.

    Iteration order is templates, then locales, then models, then instance index, and
    every collection is taken in the order the config declares. Nothing here reads a
    clock, a random source or the environment, so the row order -- and therefore the
    artifact bytes -- is a function of the config alone.
    """
    scored: list[Scored] = []
    locale_records: list[dict[str, Any]] = []
    statuses: dict[str, set[str]] = {}

    clients = {model["id"]: client_factory(model) for model in config.models}

    for template_entry in config.templates:
        path = config.template_path(template_entry)
        count = int(template_entry["count"])
        for locale in config.locales:
            tag = locale["tag"]
            try:
                template = load_template(path, tag)
            except Exception as exc:
                raise SpecError(
                    f"study needs template {template_entry['path']!r} in locale {tag!r}: {exc}"
                ) from exc
            statuses.setdefault(tag, set()).add(template["translation_status"])

            instances, _ = build_instances(template, count, tokenizer=tokenizer)
            for model in config.models:
                client = clients[model["id"]]
                for instance in instances:
                    response = client.complete(
                        model_id=model["id"],
                        prompt=instance["prompt"],
                        instance=instance,
                    )
                    verdict = run_verifier(instance["verifier"], response.text)
                    elements = verdict.detail.get("elements")
                    scored.append(
                        Scored(
                            model_id=model["id"],
                            template_id=instance["template_id"],
                            locale=tag,
                            instance_index=instance["instance_index"],
                            seed=instance["seed"],
                            verifier_family=verifier_family(instance["verifier"]),
                            passed=verdict.passed,
                            code=verdict.code,
                            elements=list(elements) if isinstance(elements, list) else None,
                            prompt_tokens=int(instance["fertility"]["prompt_tokens"]),
                            code_mix_ratio=instance["code_mix_ratio"],
                        )
                    )

    for locale in config.locales:
        tag = locale["tag"]
        found = statuses.get(tag, set())
        locale_records.append(
            {
                "tag": tag,
                "fertility_level": locale["fertility_level"],
                "resource_level": locale["resource_level"],
                # Worst status across the templates rendered for this locale. A locale is
                # only as reviewed as its least reviewed template, so a study covering one
                # translated and one placeholder template is not publishable.
                "translation_status": _worst_status(found),
            }
        )
    return scored, locale_records


#: Ordered worst first. Used to collapse several templates' statuses into one per locale.
STATUS_ORDER = ("untranslated", "single-reviewer", "native-reviewed")


def _worst_status(found: set[str]) -> str:
    for status in STATUS_ORDER:
        if status in found:
            return status
    return "untranslated"


def local_runtime_record() -> dict[str, Any]:
    """This process's provenance block."""
    return local_provenance()


#: How long to wait for Node to report its Unicode version before giving up on it.
PEER_PROBE_TIMEOUT_S = 15


def peer_runtime_record() -> dict[str, Any] | None:
    """The TypeScript runtime's versions, or ``None`` when Node is not available.

    Recorded because the reason Python is normative is that the two runtimes read
    different Unicode tables, and that is a claim a reader can only check with both
    numbers in front of them. Probed rather than pinned for the same reason the local
    one is: a pinned value would be a claim rather than a measurement.

    Absence is not an error. A machine without Node can still run a study, and an
    artifact that omits the peer record says truthfully that nothing was measured, which
    is better than carrying a number nobody read off the runtime in question.
    """
    import json
    import subprocess

    try:
        completed = subprocess.run(
            [
                "node",
                "-e",
                "process.stdout.write(JSON.stringify("
                "{unicode: process.versions.unicode ?? 'unknown', node: process.versions.node}))",
            ],
            capture_output=True,
            text=True,
            timeout=PEER_PROBE_TIMEOUT_S,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if completed.returncode != 0:
        return None
    try:
        parsed = json.loads(completed.stdout)
    except ValueError:
        return None
    return {
        "implementation": "@redrob/harness",
        "implementation_version": str(parsed.get("node", "unknown")),
        "unicode_version": str(parsed.get("unicode", "unknown")),
        "authoritative": False,
    }
