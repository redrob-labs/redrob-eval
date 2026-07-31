# Sample exports

Reproducible offline artifacts (no provider keys). Regenerate with:

```bash
yarn export:samples
```

| File | What it is |
|------|------------|
| `optimize-report.md` / `.json` | Baseline vs evolved report from `buildOptimizeReport` / `reportToMarkdown` (same path as Evolve UI export) |
| `pareto.svg` | Relative cost % vs val quality for the sample baseline and evolved points |

## Text-mode routing finding (not in these files)

Hand-written length/keyword heuristics agreed with dual-eval oracle labels only about **25%** of the time on some GSM8K slices. That measurement used live dual-eval runs (see `docs/learnings.md`, 2026-07-27). Full routing corpora stay local under `eval/routing-runs/` (gitignored) because they are generated against provider APIs; the Evolve sample above is the committed, regenerable harness evidence.
