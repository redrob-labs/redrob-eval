# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""Template loading, locale merging and schema validation.

The on-disk split between a locale-neutral core and one file per locale is the whole
locale story: a translation may change the wording and nothing else. If a locale layer
tried to redeclare parameters or the verifier it could change the task, the two locales
would no longer be the same item, and their token counts would stop being comparable.
So that is a load error rather than an override.
"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

from .__about__ import SPEC_VERSION
from .canonical import content_hash
from .errors import SpecError, TemplateLoadError
from .verify.json_schema_subset import SchemaSubsetError, validate_schema_document
from .verify.regex_subset import RegexSubsetError, validate as validate_regex_subset

SCHEMA_FILENAME = "verifiable-task-v2.schema.json"
CORE_FILENAME = "template.json"
LOCALES_DIRNAME = "locales"

# A locale layer may set these and only these. Everything else is the task, not the wording.
LOCALE_OVERRIDABLE_FIELDS = frozenset(
    {"locale", "translation_status", "description", "prompt", "notes"}
)

#: A locale layer must declare each of these. ``translation_status`` is required rather
#: than defaulted because every available default is a lie: defaulting to reviewed would
#: launder a placeholder into a publishable one, and defaulting to untranslated would
#: quietly downgrade a real translation whose author forgot the field.
LOCALE_REQUIRED_FIELDS = ("locale", "translation_status", "prompt")


def find_spec_dir() -> Path:
    """Locate ``spec/`` holding the JSON schema and the conformance suite.

    Checked in order: the ``REDROB_SPEC_DIR`` override, then every ancestor of this
    file. The upward search is what makes an editable install in the monorepo work
    without duplicating the schema into the package.
    """
    override = os.environ.get("REDROB_SPEC_DIR")
    if override:
        candidate = Path(override)
        if (candidate / SCHEMA_FILENAME).is_file():
            return candidate
        raise SpecError(f"REDROB_SPEC_DIR={override!r} does not contain {SCHEMA_FILENAME}")

    packaged = Path(__file__).resolve().parent / "_spec"
    if (packaged / SCHEMA_FILENAME).is_file():
        return packaged

    for ancestor in Path(__file__).resolve().parents:
        candidate = ancestor / "spec"
        if (candidate / SCHEMA_FILENAME).is_file():
            return candidate
    raise SpecError(
        f"could not locate {SCHEMA_FILENAME}; set REDROB_SPEC_DIR to the spec directory"
    )


@lru_cache(maxsize=1)
def load_schema() -> dict[str, Any]:
    """The full schema document, cached."""
    path = find_spec_dir() / SCHEMA_FILENAME
    return json.loads(path.read_text(encoding="utf-8"))


def subschema(pointer: str) -> dict[str, Any]:
    """A validatable schema for one ``$defs`` entry, carrying the ``$defs`` map with it."""
    schema = load_schema()
    if pointer not in schema["$defs"]:
        raise SpecError(f"unknown schema definition {pointer!r}")
    return {"$ref": f"#/$defs/{pointer}", "$defs": schema["$defs"]}


def validate_document(document: Any, pointer: str) -> None:
    """Validate ``document`` against ``#/$defs/<pointer>`` or raise :class:`SpecError`."""
    import jsonschema

    validator = jsonschema.Draft202012Validator(subschema(pointer))
    errors = sorted(validator.iter_errors(document), key=lambda error: list(error.absolute_path))
    if not errors:
        return
    first = errors[0]
    location = "/".join(str(part) for part in first.absolute_path) or "(root)"
    raise SpecError(
        f"{pointer} is invalid at {location}: {first.message}"
        + (f" (and {len(errors) - 1} more)" if len(errors) > 1 else "")
    )


def _read_json(path: Path) -> dict[str, Any]:
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise TemplateLoadError(f"could not read {path}: {exc}") from exc
    if not isinstance(parsed, dict):
        raise TemplateLoadError(f"{path} does not contain a JSON object")
    return parsed


def available_locales(directory: Path) -> list[str]:
    """Locale tags with a layer file in ``directory``, sorted."""
    locales_dir = directory / LOCALES_DIRNAME
    if not locales_dir.is_dir():
        return []
    return sorted(path.stem for path in locales_dir.glob("*.json"))


def merge_locale_layer(core: dict[str, Any], layer: dict[str, Any], origin: str) -> dict[str, Any]:
    """Overlay a locale layer onto a locale-neutral core."""
    illegal = sorted(set(layer) - LOCALE_OVERRIDABLE_FIELDS)
    if illegal:
        raise TemplateLoadError(
            f"{origin} tries to override {illegal}; a locale layer may only set "
            f"{sorted(LOCALE_OVERRIDABLE_FIELDS)}, because a translation must change the "
            "wording and never the task"
        )
    for required in LOCALE_REQUIRED_FIELDS:
        if required not in layer:
            raise TemplateLoadError(f"{origin} does not declare {required}")
    merged = dict(core)
    merged.update(layer)
    return merged


def load_template(path: str | os.PathLike[str], locale: str | None = None) -> dict[str, Any]:
    """Load and validate one template in its merged form.

    ``path`` may be a family directory, a merged single-file template, or a locale layer
    file sitting next to a ``template.json``.
    """
    target = Path(path)

    if target.is_dir():
        core_path = target / CORE_FILENAME
        if not core_path.is_file():
            raise TemplateLoadError(f"{target} does not contain {CORE_FILENAME}")
        core = _read_json(core_path)
        locales = available_locales(target)
        if not locales:
            raise TemplateLoadError(f"{target} has no {LOCALES_DIRNAME}/*.json layer")
        chosen = locale or ("en" if "en" in locales else locales[0])
        if chosen not in locales:
            raise TemplateLoadError(
                f"{target} has no locale {chosen!r}; available locales are {locales}"
            )
        layer_path = target / LOCALES_DIRNAME / f"{chosen}.json"
        merged = merge_locale_layer(core, _read_json(layer_path), str(layer_path))
    else:
        if not target.is_file():
            raise TemplateLoadError(f"{target} does not exist")
        document = _read_json(target)
        core_path = target.parent.parent / CORE_FILENAME
        if target.parent.name == LOCALES_DIRNAME and core_path.is_file():
            merged = merge_locale_layer(_read_json(core_path), document, str(target))
        else:
            merged = document
        if locale is not None and merged.get("locale") != locale:
            raise TemplateLoadError(
                f"{target} declares locale {merged.get('locale')!r}, not the requested {locale!r}"
            )

    merged.setdefault("spec_version", SPEC_VERSION)
    if merged["spec_version"] != SPEC_VERSION:
        raise TemplateLoadError(
            f"{target} declares spec version {merged['spec_version']!r}; "
            f"this generator implements {SPEC_VERSION!r}"
        )
    validate_document(merged, "template")
    _validate_parameter_shapes(merged)
    _validate_verifier_patterns(merged)
    return merged


_DERIVATION_REFERENCE = "{{"


def _validate_verifier_patterns(template: dict[str, Any]) -> None:
    """Reject an out-of-subset regex when the template is loaded, not when it is scored.

    A pattern that uses a shorthand class is wrong for every instance the template will
    ever produce, so finding out at scoring time means an entire generated set is already
    published before anyone notices. The error names the offending construct.

    A binding leaf may be a ``{{derivation}}`` reference rather than a literal, and those
    are resolved per instance and checked then.
    """

    def check(node: Any, path: str) -> None:
        if isinstance(node, list):
            for index, item in enumerate(node):
                check(item, f"{path}[{index}]")
            return
        if not isinstance(node, dict):
            return

        if node.get("type") == "regex":
            pattern = node.get("pattern")
            if isinstance(pattern, str) and _DERIVATION_REFERENCE not in pattern:
                try:
                    validate_regex_subset(pattern, node.get("flags", ()))
                except RegexSubsetError as exc:
                    raise SpecError(
                        f"template {template['id']}: verifier at {path} has a pattern "
                        f"outside the portable subset: {exc}"
                    ) from exc

        # A JSON Schema's own `pattern` and `patternProperties` keys go through the same
        # subset, so they are checked here too.
        if node.get("type") == "json_schema" and isinstance(node.get("schema"), dict):
            try:
                validate_schema_document(
                    node["schema"], normalization=node.get("normalization", "NFC")
                )
            except (SchemaSubsetError, RegexSubsetError) as exc:
                raise SpecError(
                    f"template {template['id']}: verifier at {path} carries a schema "
                    f"outside the supported subset: {exc}"
                ) from exc

        for key, value in node.items():
            if key != "schema":
                check(value, f"{path}.{key}")

    if "verifier" in template:
        check(template["verifier"], "verifier")


def _validate_parameter_shapes(template: dict[str, Any]) -> None:
    """Type-specific checks the JSON Schema cannot express without a keyword explosion."""
    seen: set[str] = set()
    for parameter in template["parameters"]:
        name = parameter["name"]
        if name in seen:
            raise SpecError(f"template {template['id']} declares parameter {name!r} twice")
        seen.add(name)
        kind = parameter["type"]
        if kind in ("integer", "number"):
            if "min" not in parameter or "max" not in parameter:
                raise SpecError(f"parameter {name!r} of type {kind} needs both min and max")
            if parameter["min"] > parameter["max"]:
                raise SpecError(f"parameter {name!r} has min above max")
            if kind == "integer" and (
                parameter["min"] != int(parameter["min"]) or parameter["max"] != int(parameter["max"])
            ):
                raise SpecError(f"integer parameter {name!r} has non-integral bounds")
        elif kind in ("choice", "subset", "permutation"):
            if not parameter.get("choices"):
                raise SpecError(f"parameter {name!r} of type {kind} needs a non-empty choices list")
            if kind == "subset":
                size = parameter.get("size")
                if size is None:
                    raise SpecError(f"subset parameter {name!r} needs a size")
                if size > len(parameter["choices"]):
                    raise SpecError(f"subset parameter {name!r} wants more elements than it has")

    for derivation in template.get("derivations", []):
        name = derivation["name"]
        if name in seen:
            raise SpecError(f"derivation {name!r} shadows a parameter of the same name")
        seen.add(name)


def template_content_hash(template: dict[str, Any]) -> str:
    """Content hash of a merged template, per spec section 9.1."""
    return content_hash(template)
