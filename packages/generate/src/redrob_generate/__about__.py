# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""Version constants.

``GENERATOR_VERSION`` is an input to seed derivation, so bumping it changes every
generated set. That coupling is deliberate: it is what lets a third party recompute
the seeds of a published set from nothing but the version string and the template id.
"""

SPEC_VERSION = "redrob-verifiable-task/v2"
GENERATOR_NAME = "redrob-generate"
GENERATOR_VERSION = "0.1.0"
TOOL_NAME = "redrob-eval"
TOOL_VERSION = "0.1.0"
