# Copyright 2026 Janghoon Lee
# SPDX-License-Identifier: Apache-2.0
"""Study runner: generate across locales, ask models, score, aggregate.

One study measures what a language costs on a set of models. The design that makes the
measurement mean anything lives in :mod:`redrob_generate.seed` rather than here: a seed
is derived from the generator version, the template id and the instance index, with no
locale term, so instance 3 of a template is *the same item* in English, Korean, Hindi
and Hinglish. Only the wording differs. That is what licenses a paired comparison, and
it is why this package compares locales pair by pair rather than as two independent
samples.
"""

from .config import StudyConfig, load_study_config
from .models import (
    MockModelClient,
    ModelClient,
    ModelResponse,
    HarnessModelClient,
    synthesize_passing_answer,
)
from .publish import PublicationRefused, assert_publishable
from .result import build_result
from .runner import run_study
from .table import render_table

__all__ = [
    "HarnessModelClient",
    "MockModelClient",
    "ModelClient",
    "ModelResponse",
    "PublicationRefused",
    "StudyConfig",
    "assert_publishable",
    "build_result",
    "load_study_config",
    "render_table",
    "run_study",
    "synthesize_passing_answer",
]
