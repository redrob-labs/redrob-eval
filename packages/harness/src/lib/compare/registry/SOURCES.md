# Compare model registry — sources

This directory holds an **illustrative** capability registry for multi-axis
model comparison. Numbers are snapshots for offline ranking demos — **not**
Redrob production rates, failure rates, or unit economics.

## License

Registry content is factual reference metadata (URLs, published latency/Elo
snapshots, and internal rate ratios used only for relative-cost math). It is
distributed under the same **Apache-2.0** license as redrob-eval.

Open-weight model licenses are listed per entry (`openWeights.license` + URL)
and remain governed by those upstream licenses.

## How to extend

1. Edit `models.json` (or replace it with your own file).
2. Add a `sources[]` row for every `rates` / `published` / `openWeights` field
   you set: `{ "field": "...", "url": "...", "retrieved": "YYYY-MM-DD" }`.
3. **Do not impute** missing `published` fields — leave them absent.
4. Raw `rates` are for server-side relative-cost math only. They must never be
   rendered in the UI, written to exports, or returned from `/api/compare*`.
5. Re-run `yarn verify:compare` after edits.

## Retrieval

Primary public pages consulted while seeding this illustrative set
(retrieved **2026-08-01**):

| Source | URL |
|--------|-----|
| OpenAI API pricing | https://openai.com/api/pricing/ |
| Anthropic pricing | https://www.anthropic.com/pricing |
| Google AI pricing | https://ai.google.dev/pricing |
| OpenRouter model pages | https://openrouter.ai/models |
| LMSYS Chatbot Arena | https://lmarena.ai/ |
| Llama license pages | https://www.llama.com/ |
| Qwen2.5 on Hugging Face | https://huggingface.co/Qwen/Qwen2.5-72B-Instruct |
| Mistral Small 3.1 | https://mistral.ai/news/mistral-small-3-1 |

`published.benchmarkComposite` values are **illustrative composites** for UI/math
demos (URL placeholder `https://example.invalid/illustrative-composite`). Replace
with your own eval-run scores via `qualitySource: "run"` for real decisions.
