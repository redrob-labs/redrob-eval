# Primary research workflow

```text
Generate → Compare → Analyze
             ↑
       hosted APIs / Deploy

Analyze → Evolve → Compare → Analyze
```

Deploy is a model source, not a required research stage. Hosted APIs skip it;
self-hosted models pass through it and return to Compare. Evolve starts the
improvement loop after a first analysis.

## Generate

Choose a text template and sample a deterministic benchmark in the browser.
Exact and numeric-tolerance verifiers carry a single reference answer, so the
handoff includes:

- prompt and stable instance id
- flat reference answer, for Expected/Asked/Got
- original bound verifier, which remains authoritative for scoring
- metric and template version/path/locale/seeds

Format-only verifiers describe many valid outputs, so they remain unscored
rather than inventing one gold string.

The Python CLI does not need an editable install in a source checkout. Generate
prefers `redrob-generate` (or `REDROB_GENERATE_CMD`) and falls back to loading
`packages/generate/src` directly through `python3`.

## Compare

The handoff opens Compare with Custom prompts already selected. Image comparison
is intentionally absent from the product surface for now, so there is no
modality decision before the text benchmark. Image suites, judges, APIs and
adapters remain dormant for later wiring.

Reference sets are scored with the bound verifier, not a generic string metric:
`13.8000` is therefore a pass against numeric reference `13.8` at tolerance
`1e-4`. A flat `gold` is kept beside it for readers.

Every completed text comparison becomes a registry run (`compare-text`) and
stores one `redrob-text-eval/v1` artifact containing:

- prompts and references
- every model prediction and score
- latency and provider errors
- aggregate target summaries

The primary completion action is **Analyze this run**. Preference remains
available as a secondary path when a human ranking is useful.

## Analyze

The completion link deep-links directly to the new run. Analyze classifies
provider errors and wrong/partial/empty answers, renders Expected/Asked/Got, and
compares models on deterministic pass rate with:

- Wilson intervals
- paired bootstrap difference
- exact McNemar test
- Holm adjustment across pairs
- warnings when the shared item count cannot support a claim

Nothing is reconstructed from browser state: the evidence lives in the run
artifact, so refreshes and later sessions read the same record.

## Image comparison

The image pipeline is not deleted. `COMPARE_IMAGE_UI_ENABLED` is false, which
hides the modality and avoids suite fetching. Re-enabling it later is a product
decision and a switch, not recovery from removed backend code.
