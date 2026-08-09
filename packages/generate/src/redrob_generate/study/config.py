# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""Study config loading and validation."""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from ..__about__ import GENERATOR_VERSION
from ..errors import SpecError
from ..spec import SCHEMA_FILENAME, find_spec_dir, load_schema

STUDY_SCHEMA_FILENAME = "study-v1.schema.json"
STUDY_VERSION = "redrob-study/v1"


@lru_cache(maxsize=1)
def load_study_schema() -> dict[str, Any]:
    path = find_spec_dir() / STUDY_SCHEMA_FILENAME
    if not path.is_file():
        raise SpecError(f"could not locate {STUDY_SCHEMA_FILENAME} beside {SCHEMA_FILENAME}")
    return json.loads(path.read_text(encoding="utf-8"))


def validate_study_document(document: Any, pointer: str) -> None:
    """Validate against ``#/$defs/<pointer>`` of the study schema.

    The study schema refers to the task schema across files, so both documents are put
    into a registry rather than the refs being flattened into one blob. Flattening would
    work today and would silently stop matching the file on disk the moment either
    schema changed.
    """
    import jsonschema
    from referencing import Registry, Resource
    from referencing.jsonschema import DRAFT202012

    task_schema = load_schema()
    study_schema = load_study_schema()
    registry = Registry().with_resources(
        [
            (SCHEMA_FILENAME, Resource(contents=task_schema, specification=DRAFT202012)),
            (STUDY_SCHEMA_FILENAME, Resource(contents=study_schema, specification=DRAFT202012)),
        ]
    )
    validator = jsonschema.Draft202012Validator(
        {"$ref": f"#/$defs/{pointer}", "$defs": study_schema["$defs"]},
        registry=registry,
    )
    errors = sorted(validator.iter_errors(document), key=lambda error: list(error.absolute_path))
    if not errors:
        return
    first = errors[0]
    location = "/".join(str(part) for part in first.absolute_path) or "(root)"
    raise SpecError(
        f"{pointer} is invalid at {location}: {first.message}"
        + (f" (and {len(errors) - 1} more)" if len(errors) > 1 else "")
    )


@dataclass(frozen=True)
class StudyConfig:
    """A validated study config, with template paths already resolved."""

    document: dict[str, Any]
    source: Path

    @property
    def id(self) -> str:
        return str(self.document["id"])

    @property
    def templates(self) -> list[dict[str, Any]]:
        return list(self.document["templates"])

    @property
    def locales(self) -> list[dict[str, Any]]:
        return list(self.document["locales"])

    @property
    def models(self) -> list[dict[str, Any]]:
        return list(self.document["models"])

    @property
    def comparisons(self) -> list[dict[str, Any]]:
        return list(self.document["comparisons"])

    @property
    def tokenizer(self) -> dict[str, Any]:
        return dict(self.document["fertility_tokenizer"])

    @property
    def seed_policy(self) -> dict[str, Any]:
        return dict(self.document["seed_policy"])

    def template_path(self, entry: dict[str, Any]) -> Path:
        """Resolve a template path relative to the config file, not the shell's cwd."""
        return (self.source.parent / entry["path"]).resolve()


def load_study_config(path: str | Path) -> StudyConfig:
    source = Path(path).resolve()
    if not source.is_file():
        raise SpecError(f"study config {source} does not exist")
    try:
        document = json.loads(source.read_text(encoding="utf-8"))
    except ValueError as exc:
        raise SpecError(f"study config {source} is not JSON: {exc}") from exc

    validate_study_document(document, "study_config")

    declared = {locale["tag"] for locale in document["locales"]}
    duplicates = sorted(
        tag for tag in declared if sum(1 for x in document["locales"] if x["tag"] == tag) > 1
    )
    if duplicates:
        raise SpecError(f"study config declares locale(s) {duplicates} more than once")

    for comparison in document["comparisons"]:
        for side in ("left", "right"):
            if comparison[side] not in declared:
                raise SpecError(
                    f"comparison {comparison['id']!r} names locale {comparison[side]!r}, "
                    f"which the study does not declare; declared locales are {sorted(declared)}"
                )
        if comparison["left"] == comparison["right"]:
            raise SpecError(f"comparison {comparison['id']!r} compares a locale with itself")

    # The seed policy records the generator version the study was designed against.
    # Running it under a different one would change every seed, so the items would not
    # be the items the config describes and a rerun would not reproduce the artifact.
    declared_version = document["seed_policy"]["generator_version"]
    if declared_version != GENERATOR_VERSION:
        raise SpecError(
            f"study config declares generator version {declared_version!r} but this is "
            f"{GENERATOR_VERSION!r}; seeds derive from the generator version, so the "
            "instances would differ from the ones the config describes"
        )

    for model in document["models"]:
        if model["provider"] == "mock" and "mock_strategy" not in model:
            raise SpecError(
                f"model {model['id']!r} uses the mock provider without a mock_strategy; "
                "there is no default because every default is a silent assumption about "
                "how good the imaginary model is"
            )

    config = StudyConfig(document=document, source=source)
    for entry in document["templates"]:
        resolved = config.template_path(entry)
        if not resolved.is_dir():
            raise SpecError(
                f"study config template path {entry['path']!r} resolves to {resolved}, "
                "which is not a directory"
            )
    return config
