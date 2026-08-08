# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""Command line interface.

This CLI is the *only* bridge boundary. A non-Python caller runs it as a subprocess and
exchanges JSON. There is no HTTP service and no other IPC mechanism, because every extra
channel is another place two implementations can drift, and a subprocess needs no port,
no auth and no lifecycle.

    redrob-generate emit   --template <path> --count <n> --out <dir>
    redrob-generate verify --set <dir> --outputs <path> --json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Iterable, Sequence

from .__about__ import GENERATOR_NAME, GENERATOR_VERSION, SPEC_VERSION
from .canonical import canonical_json, write_canonical_json
from .errors import RedrobGenerateError
from .fertility import summarize
from .generate import build_instances
from .manifest import build_manifest, utc_now_rfc3339
from .spec import load_template, template_content_hash, validate_document
from .verify import run_verifier

INSTANCES_FILENAME = "instances.jsonl"
MANIFEST_FILENAME = "manifest.json"


# ------------------------------------------------------------------------- emit


def _write_instances(path: Path, instances: Iterable[dict[str, Any]]) -> None:
    """One canonical JSON object per line, LF endings, UTF-8, no BOM."""
    lines = [canonical_json(instance) for instance in instances]
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        for line in lines:
            handle.write(line + "\n")


def command_emit(args: argparse.Namespace) -> int:
    template = load_template(args.template, args.locale)
    instances, records = build_instances(template, args.count)

    fertility = None
    if records:
        raise RedrobGenerateError(
            "fertility records were produced without a tokenizer, which cannot happen"
        )

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    _write_instances(out_dir / INSTANCES_FILENAME, instances)

    manifest = build_manifest(
        templates=[
            {
                "id": template["id"],
                "version": template["version"],
                "locale": template["locale"],
                "content_hash": template_content_hash(template),
                "instance_count": len(instances),
            }
        ],
        instance_count=len(instances),
        locale=template["locale"],
        created_at=args.created_at or utc_now_rfc3339(),
        fertility=fertility,
        doi=args.doi,
        citation_year=args.citation_year,
    )
    validate_document(manifest, "manifest")
    write_canonical_json(out_dir / MANIFEST_FILENAME, manifest)

    if not args.quiet:
        # One line, on completion, so that a citation is impossible to miss and
        # impossible to find annoying.
        print(
            f"{len(instances)} instances of {template['id']} "
            f"[{template['locale']}] written to {out_dir}. "
            f"Cite this set: DOI {manifest['citation']['doi']}, "
            f"BibTeX in {MANIFEST_FILENAME}.",
            file=sys.stderr,
        )
    return 0


# ----------------------------------------------------------------------- verify


def _read_outputs(source: str) -> dict[int, str]:
    """Read model outputs.

    Accepts JSONL of ``{"instance_index": n, "output": "..."}``, a JSON array of the
    same objects, a JSON array of bare strings positionally, or a JSON object keyed by
    index. ``-`` reads stdin. Being liberal here costs nothing; being liberal about
    *verdicts* would cost everything.
    """
    text = sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8")
    stripped = text.strip()
    if stripped == "":
        return {}

    # JSONL also starts with '{', so a whole-document parse is tried first and the
    # line-oriented reading is the fallback rather than the other way round.
    parsed: Any = None
    if stripped[0] in "[{":
        try:
            parsed = json.loads(stripped)
        except ValueError:
            parsed = None
    if parsed is not None:
        if isinstance(parsed, dict):
            return {int(key): str(value) for key, value in parsed.items()}
        if isinstance(parsed, list):
            outputs: dict[int, str] = {}
            for position, entry in enumerate(parsed):
                if isinstance(entry, str):
                    outputs[position] = entry
                elif isinstance(entry, dict):
                    outputs[int(entry["instance_index"])] = str(entry["output"])
                else:
                    raise RedrobGenerateError(f"output entry {position} is not a string or object")
            return outputs
        raise RedrobGenerateError("outputs JSON must be an array or an object")

    outputs = {}
    for number, line in enumerate(stripped.splitlines(), start=1):
        if line.strip() == "":
            continue
        try:
            entry = json.loads(line)
        except ValueError as exc:
            raise RedrobGenerateError(f"outputs line {number} is not JSON: {exc}") from exc
        # Deliberately not accepting one bare line per output: a model output routinely
        # contains newlines, so that format would silently split an answer in half.
        if not isinstance(entry, dict) or "instance_index" not in entry or "output" not in entry:
            raise RedrobGenerateError(
                f"outputs line {number} must be a JSON object with 'instance_index' and "
                f"'output'; got {entry!r}"
            )
        outputs[int(entry["instance_index"])] = str(entry["output"])
    return outputs


def _read_instances(set_dir: Path) -> list[dict[str, Any]]:
    path = set_dir / INSTANCES_FILENAME
    if not path.is_file():
        raise RedrobGenerateError(f"{set_dir} does not contain {INSTANCES_FILENAME}")
    instances = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if line.strip() == "":
            continue
        try:
            instances.append(json.loads(line))
        except ValueError as exc:
            raise RedrobGenerateError(f"{path} line {number} is not JSON: {exc}") from exc
    return instances


def command_verify(args: argparse.Namespace) -> int:
    set_dir = Path(args.set)
    instances = _read_instances(set_dir)
    outputs = _read_outputs(args.outputs)

    results = []
    passed_count = 0
    for instance in instances:
        index = instance["instance_index"]
        if index not in outputs:
            results.append(
                {
                    "instance_index": index,
                    "template_id": instance["template_id"],
                    "verifier_type": instance["verifier"]["type"],
                    "passed": False,
                    "code": "parse_error",
                    "message": "no model output was supplied for this instance",
                }
            )
            continue
        verdict = run_verifier(
            instance["verifier"],
            outputs[index],
            allow_executable=args.allow_executable,
        )
        if verdict.passed:
            passed_count += 1
        results.append(
            {
                "instance_index": index,
                "template_id": instance["template_id"],
                "verifier_type": instance["verifier"]["type"],
                **verdict.to_dict(),
            }
        )

    payload = {
        "spec_version": SPEC_VERSION,
        "generator_name": GENERATOR_NAME,
        "generator_version": GENERATOR_VERSION,
        "set": str(set_dir),
        "instance_count": len(instances),
        "passed_count": passed_count,
        "results": results,
    }
    # --json is accepted and ignored: JSON is the only output format, because the
    # TypeScript client parses this stream and a second format would be a second
    # contract to keep in sync.
    sys.stdout.write(json.dumps(payload, sort_keys=True, ensure_ascii=False) + "\n")
    return 0 if passed_count == len(instances) else 1


# ------------------------------------------------------------------------ entry


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=GENERATOR_NAME,
        description=(
            "Generate verifiable evaluation prompts and verify model outputs against them "
            f"({SPEC_VERSION})."
        ),
    )
    parser.add_argument("--version", action="version", version=GENERATOR_VERSION)
    subparsers = parser.add_subparsers(dest="command", required=True)

    emit = subparsers.add_parser("emit", help="write instances plus a manifest")
    emit.add_argument("--template", required=True, help="template directory or merged JSON file")
    emit.add_argument("--count", type=int, required=True, help="number of instances")
    emit.add_argument("--out", required=True, help="output directory")
    emit.add_argument("--locale", default=None, help="locale layer to render, default en")
    emit.add_argument(
        "--created-at",
        default=None,
        help="pin the manifest timestamp, for byte-identical reruns",
    )
    emit.add_argument("--doi", default="TBD", help="DOI recorded in the citation block")
    emit.add_argument(
        "--citation-year",
        type=int,
        default=None,
        help="year in the BibTeX entry; an argument rather than a clock read, so reruns match",
    )
    emit.add_argument("--quiet", action="store_true", help="suppress the citation notice")
    emit.set_defaults(handler=command_emit)

    verify = subparsers.add_parser("verify", help="verify model outputs against a generated set")
    verify.add_argument("--set", required=True, help="directory written by emit")
    verify.add_argument("--outputs", required=True, help="model outputs file, or - for stdin")
    verify.add_argument("--json", action="store_true", help="accepted for symmetry; always on")
    verify.add_argument(
        "--no-executable",
        dest="allow_executable",
        action="store_false",
        help="refuse executable verifiers instead of running model-derived code",
    )
    verify.set_defaults(handler=command_verify, allow_executable=True)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.handler(args))
    except RedrobGenerateError as error:
        print(f"{GENERATOR_NAME}: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
