# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""A plain-text view of the aggregates.

The only display code in the project for study results, and deliberately the least
capable thing that answers "did that do what I expected". It reads the artifact, so it
cannot show a number the artifact does not contain.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence


def _format_cell(value: Any) -> str:
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, float):
        return f"{value:.3f}"
    return str(value)


def _table(headers: Sequence[str], rows: Sequence[Sequence[Any]]) -> list[str]:
    """A fixed-width table. Numeric columns right-aligned, everything else left."""
    cells = [[_format_cell(value) for value in row] for row in rows]
    widths = [len(header) for header in headers]
    for row in cells:
        for index, value in enumerate(row):
            widths[index] = max(widths[index], len(value))
    numeric = [
        all(isinstance(row[index], (int, float)) and not isinstance(row[index], bool) for row in rows)
        for index in range(len(headers))
    ]

    def line(values: Sequence[str]) -> str:
        parts = [
            values[index].rjust(widths[index]) if numeric[index] else values[index].ljust(widths[index])
            for index in range(len(values))
        ]
        return "  ".join(parts).rstrip()

    out = [line(list(headers)), "  ".join("-" * width for width in widths)]
    out.extend(line(row) for row in cells)
    return out


def render_table(result: Mapping[str, Any]) -> str:
    """The aggregates, as text."""
    aggregates = result.get("aggregates", {})
    out: list[str] = []

    out.append(f"study: {result.get('study_id')}  ({result.get('study_version')})")
    provenance = result.get("provenance", {})
    tokenizer = provenance.get("tokenizer", {})
    out.append(f"tokenizer: {tokenizer.get('name')} {tokenizer.get('version')}")
    for runtime in provenance.get("runtimes", []):
        mark = "authoritative" if runtime.get("authoritative") else "display only"
        out.append(
            f"runtime: {runtime.get('implementation')} {runtime.get('implementation_version')}"
            f"  unicode {runtime.get('unicode_version')}  [{mark}]"
        )

    out.append("")
    out.append("locales")
    out.extend(
        _table(
            ["tag", "fertility", "resource", "translation"],
            [
                [
                    locale["tag"],
                    locale["fertility_level"],
                    locale["resource_level"],
                    locale["translation_status"],
                ]
                for locale in result.get("locales", [])
            ],
        )
    )

    out.append("")
    out.append("accuracy per locale per verifier family")
    out.extend(
        _table(
            ["model", "locale", "verifier family", "n", "passed", "accuracy"],
            [
                [row["model_id"], row["locale"], row["verifier_family"], row["n"], row["passed"], row["accuracy"]]
                for row in aggregates.get("accuracy", [])
            ],
        )
    )

    out.append("")
    out.append("mean prompt tokens per locale")
    out.extend(
        _table(
            ["locale", "n", "mean tokens"],
            [[row["locale"], row["n"], row["mean_prompt_tokens"]] for row in aggregates.get("tokens", [])],
        )
    )

    out.append("")
    out.append("paired deltas (right minus left, matched on template and instance)")
    out.extend(
        _table(
            ["comparison", "left", "right", "pairs", "tok left", "tok right", "tok delta", "acc delta"],
            [
                [
                    row["comparison"],
                    row["left"],
                    row["right"],
                    row["n_pairs"],
                    row["mean_prompt_tokens_left"],
                    row["mean_prompt_tokens_right"],
                    row["mean_prompt_tokens_delta"],
                    row["accuracy_delta"],
                ]
                for row in aggregates.get("paired_deltas", [])
            ],
        )
    )

    stubs = [
        locale["tag"]
        for locale in result.get("locales", [])
        if locale["translation_status"] == "untranslated"
    ]
    if stubs:
        out.append("")
        out.append(
            f"NOT PUBLISHABLE: {', '.join(stubs)} render placeholder text, so their "
            "per-locale numbers measure the placeholder."
        )
    return "\n".join(out) + "\n"
