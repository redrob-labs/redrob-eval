# Contributing

Thanks for improving redrob-eval.

## Setup

```bash
cp .env.example .env   # add provider keys you need
yarn install
yarn verify:phase1 && yarn verify:gepa && yarn verify:phase3
yarn typecheck
```

Do not commit `.env`, caches, run artifacts, or model weights.

## Development

- App: `yarn dev` → http://localhost:3939 (only when you need the UI)
- Typecheck: `yarn typecheck`
- Production build: `yarn build`

Prefer changes in `packages/harness` for optimizer / metrics / providers; keep `apps/web` thin (UI + route handlers).

## Rules of the road

1. **No absolute currency** in UI, APIs, logs, or caches - relative cost weights / percentages only.
2. **No secrets** - keys stay in `.env` (gitignored). Rotate any key that was ever pasted into chat or a screenshot.
3. **Split isolation** - do not optimize against `test` if you also report test metrics. The API must refuse that.
4. **Datasets** - only Apache-2.0-compatible (or otherwise OSS-distributable) rows under `datasets/`. CC-BY-NC / gated material goes in `datasets/local/` (gitignored).
5. **GEPA** - TypeScript reimplementation in `packages/harness`; do not add a Python GEPA dependency to the app run path. Optional parity lives in `scripts/parity/`.
6. **Python** - `train/` and `scripts/parity/` are research-only; never required for `yarn install && yarn dev`.

## Pull requests

- Keep PRs focused; include why, not just what.
- Run the verify scripts that touch your change.
- Update README / NOTICE when adding datasets, attributions, or user-facing behavior.

## Code of conduct

Be respectful. Harassment or bad-faith abuse of issues/PRs will not be tolerated.
