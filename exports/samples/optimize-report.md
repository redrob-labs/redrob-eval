# Optimize report: sample_offline_in22-hi-en

- Dataset: in22-gen-hi-en
- Optimizer: gepa
- Quality floor: 0.5
- Created: 2026-07-31T00:00:00.000Z

## Baseline
- Model: test/model
- Script: {"instruction":"romanize","demos":"romanize","input":"romanize"}
- Frame: null
- Demos requested/fitted: 3/2
- Frames requested/fitted: 0/0
- Val quality: 0.6000
- Val tokens: 200
- Instruction:
```
Translate carefully.
```

## Evolved
- Model: test/model
- Script: {"instruction":"romanize","demos":"romanize","input":"romanize"}
- Frame: null
- Demos requested/fitted: 3/3
- Frames requested/fitted: 0/0
- Val quality: 0.7000
- Val tokens: 120
- Instruction:
```
Improved instruction for Indic translation under a token budget.
```

## Delta (relative)
- Token Δ (val): -80
- Quality Δ (val): 0.1000
- Relative cost vs baseline: 62.5%

## Notes
- Some token counts were estimated (tokenizer unavailable).

