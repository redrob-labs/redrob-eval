# scripts/parity

Research-only comparison of TypeScript `Gepa` (`@redrob/harness`) against the
reference Python GEPA ([gepa-ai/gepa](https://github.com/gepa-ai/gepa), MIT).

**Not required** to install, build, run, or test the application.
Excluded from the default CI / `yarn verify:phase1` path.

## Offline checks (no Python)

```bash
yarn verify:gepa
```

Covers frontier coverage sampling, accept-if-improved semantics, system-aware
merge gene picking, and split-isolation refuse — without provider API calls.

## Optional reference comparison

1. Create a venv and `pip install -r scripts/parity/requirements.txt`
2. Run a tiny shared toy task in both stacks with the same seed / minibatch
3. Record agreement (frontier membership, mutated instruction similarity) in
   `scripts/parity/results/` (gitignored)

Do not add Python deps to root `package.json` or app workspaces.
