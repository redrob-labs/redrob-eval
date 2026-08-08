#!/usr/bin/env python3
# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""Hash the Next.js build output with the per-build identifier normalised away.

Next.js embeds a random BUILD_ID in both filenames and file contents, so two builds of an
identical tree never hash the same and a raw comparison is all noise. Replacing that one
token with a placeholder makes the output comparable; anything still differing afterwards
is a real difference, which is what makes this usable as evidence that a change to a
shared config did not alter what the application compiles to.

Five files stay unstable even after normalisation, because they carry a build trace or a
freshly generated encryption key rather than compiled output: ``trace``, ``trace-build``,
``prerender-manifest.json`` and the two ``server-reference-manifest`` files. Callers
exclude them, and a control run of two identical builds is what proves the exclusion list
is complete rather than convenient.

Usage: python3 scripts/snapshot-build-output.py [build-directory]
"""

from __future__ import annotations

import hashlib
import os
import sys


def main() -> int:
    root = sys.argv[1] if len(sys.argv) > 1 else os.path.join("apps", "web", ".next")
    build_id_path = os.path.join(root, "BUILD_ID")
    if not os.path.isfile(build_id_path):
        print(f"{root} has no BUILD_ID; is it a Next.js build output?", file=sys.stderr)
        return 1

    with open(build_id_path, "rb") as handle:
        build_id = handle.read().strip()

    rows: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [name for name in dirnames if name != "cache"]
        for name in filenames:
            full = os.path.join(dirpath, name)
            relative = os.path.relpath(full, root).replace(build_id.decode(), "<BUILD_ID>")
            if relative == "BUILD_ID":
                continue
            with open(full, "rb") as handle:
                data = handle.read().replace(build_id, b"<BUILD_ID>")
            rows.append(f"{hashlib.sha256(data).hexdigest()}  {relative}")

    for row in sorted(rows):
        print(row)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
