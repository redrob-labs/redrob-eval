# Dataset fetcher

Regenerates pinned JSON under `datasets/` from Hugging Face datasets-server.

```bash
yarn datasets:fetch
yarn datasets:fetch --id=gsm8k-main
```

`indic-glue-iitp-mr-hi` writes to `datasets/local/` (gitignored) because of CC-BY-NC / external terms — do not commit those rows.
