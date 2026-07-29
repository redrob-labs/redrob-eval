# `@redrob/tokenizers`

Measures tokenizer **fertility** (tokens per word) with the actual Hugging Face
tokenizer for a model via `@huggingface/transformers` `AutoTokenizer.from_pretrained`.

```ts
import { measureFertility, countTokens } from '@redrob/tokenizers';

const f = await measureFertility({
  modelId: 'meta-llama/llama-3.1-8b-instruct',
  text: 'नमस्ते दुनिया',
  languageHint: 'hi',
});
// f.fertility = tokens / words (measured, not estimated from char count)
```

Used by `@redrob/harness` for Phase 3 token economics. Never emits absolute currency.
