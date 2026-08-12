# datasets/

Pinned eval subsets consumed offline by `@redrob/harness`.

Each JSON file includes `source`, `revision`, `retrieved_at`, and `license`.

| File | License | Notes |
|------|---------|-------|
| `gsm8k-main.json` | MIT | Committed |
| `mmlu-pooled.json` | MIT | Committed; attribute cais/mmlu (MMLU) |
| `in22-gen-hi-en.json` | CC-BY-4.0 | Committed; attribute AI4Bharat IN22 |
| `fixtures/accuracy-fixture.json` | Apache-2.0 | Synthetic smoke data |
| `local/*` | varies | Gitignored; for any set whose terms bar redistribution. Empty today |
| `video-local/*` | local non-redistributable | Gitignored manifests; frame paths outside repo (see README) |

Regenerate vendored sets: `yarn datasets:fetch` (see `scripts/datasets/`).
