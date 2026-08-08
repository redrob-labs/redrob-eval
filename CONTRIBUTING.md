# Contributing

Thanks for improving redrob-eval.

## Setup

```bash
cp .env.example .env   # add provider keys you need
yarn install
yarn verify:phase1 && yarn verify:gepa && yarn verify:phase3
yarn verify:preference-gen
yarn typecheck
```

Do not commit `.env`, caches, run artifacts, or model weights.

## Branching model

Two long-lived branches:

- **`main` is production.** It only ever receives a release merge from `develop`, or a hotfix.
  Every commit on it is meant to be deployable, and is tagged. Do not push to it directly and do
  not open a pull request against it for ordinary work.
- **`develop` is the integration branch.** Everything lands here first. It is the base you branch
  from and the base your pull request targets.

Short-lived branches, all named for what they do:

| Prefix | Branch from | Merge into | For |
| --- | --- | --- | --- |
| `feature/` | `develop` | `develop` | anything additive |
| `fix/` | `develop` | `develop` | a bug that is not on fire |
| `refactor/` | `develop` | `develop` | behaviour-preserving change |
| `release/` | `develop` | `main` **and** `develop` | version bump, changelog, final checks |
| `hotfix/` | `main` | `main` **and** `develop` | a production defect that cannot wait |

The two branches that merge to `main` also merge back to `develop`. Skipping the merge back is
how a fix reaches production and then disappears in the next release, so it is worth doing at the
time rather than remembering later.

```bash
git checkout develop && git pull
git checkout -b feature/short-description
# ... commits ...
git push -u origin feature/short-description   # then open a PR into develop
```

A release is the only way work reaches `main`:

```bash
git checkout -b release/0.2.0 develop
# version bump, changelog, no new features
# PR into main, tag main as v0.2.0, then merge the tag back into develop
```

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

- **Target `develop`, not `main`.** A PR against `main` will be asked to retarget unless it is a
  release or a hotfix.
- Keep PRs focused; include why, not just what.
- Run the verify scripts that touch your change.
- Update README / NOTICE when adding datasets, attributions, or user-facing behavior.

## Code of conduct

Be respectful. Harassment or bad-faith abuse of issues/PRs will not be tolerated.
