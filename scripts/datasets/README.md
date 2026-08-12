# Dataset fetcher

Regenerates pinned JSON under `datasets/` from Hugging Face datasets-server.

```bash
yarn datasets:fetch
yarn datasets:fetch --id=gsm8k-main
```

A dataset whose terms bar redistribution goes in `LOCAL_ONLY_DATASET_IDS` and writes to `datasets/local/` (gitignored) instead. The catalog has none today.
