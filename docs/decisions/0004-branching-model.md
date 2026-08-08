# 0004. Branching model: `main` is production, `develop` integrates

Status: **provisional**. The branch and the documentation are in place; three repository settings
that the model depends on cannot be set from a pull request and are listed as outstanding.
Supersedes: nothing.
Superseded by: nothing.
Applies to: `CONTRIBUTING.md`, `.github/workflows/ci.yml`, `.github/workflows/conformance.yml`.

Until now the project had one long-lived branch. The Generate module was squash merged straight
into `main`, which is what prompted this: `main` is meant to be what is deployed, and a draft spec
with an uncited version number is not that. This record fixes the model and the naming.

---

## 1. The name is `develop`

Chosen over `dev` and `development`.

`develop` is the name in Vincent Driessen's original description of the model, and it is the
default that the `git-flow` command line tool creates and expects. Anyone who has used the model
before will guess it correctly, and any tutorial a new contributor finds will match the repository
without translation. `dev` is shorter but collides with the `dev` script (`yarn dev`) and with the
`dev` short form for developer, which makes prose ambiguous in a way the extra four characters
avoid. `development` is unambiguous but nothing defaults to it.

This is a low-stakes choice and it is reversible with a rename, but it is worth making once rather
than leaving each contributor to guess.

## 2. Prefixes are `feature/`, `fix/`, `refactor/`, `release/`, `hotfix/`

Driessen specifies `feature/`, `release/` and `hotfix/`. `fix/` and `refactor/` are added because
the repository already had a `refactor/verifier-list` branch and calling a refactor a feature to
satisfy a taxonomy makes the taxonomy worth less than the branch name. All three of the
non-release prefixes behave identically — branch from `develop`, merge to `develop` — so the
distinction is documentation for the reader, not a rule anything enforces.

## 3. The Generate module stays on `main`; the merge is not reverted

This is the decision most open to disagreement, so the reasoning is stated in full.

Under the model adopted here, the Generate module should have gone to `develop` and reached `main`
only through a release. It did not; it is on `main` as commit `4bddd21`. The tidy-looking response
is to revert it on `main` and let `develop` carry it until a release. That was rejected for two
reasons.

The first is that it does not work cleanly. `develop` is branched from `main` *at* `4bddd21`, so
if `main` then gains a revert commit `R`, the eventual release merge of `develop` into `main` has
`4bddd21` as its merge base. `develop` has made no change to those files since the merge base;
`main` has deleted them in `R`. Git resolves that as the deletion winning, and the release
silently ships without the module. Recovering means reverting `R` at release time, and a
revert-of-a-revert is a thing someone has to know to look for. Trading a tidy `main` today for
that trap later is a bad trade.

The second is that the revert buys nothing real. The code is public and already fetched; reverting
does not unpublish it. What `main` containing a draft spec actually risks is someone treating the
spec as stable, and that is addressed where it is read — `spec/verifiable-task-v1.md` opens with a
draft notice telling readers to pin a commit rather than track the branch.

So `4bddd21` is treated as the current production baseline. The cost is that `main`'s history has
one commit that did not follow the model that did not exist when it was made, and this record is
the note explaining it.

**Recommended follow-up, not done here:** tag `main` as `v0.1.0`. Right now "production" is a
branch pointer with no released version, so "deploy what is on `main`" and "deploy the last
release" are the same sentence with no way to tell them apart. Tagging is left to a human because
choosing the version number is a claim about maturity that this record should not make on its own.

## 4. CI now builds `develop`

Both workflows triggered on `push: [main, master]`. `develop` is added, so the integration branch
is built on every push rather than only when a pull request happens to target it. `master` is
removed in the same edit: the repository has no such branch, and a trigger for a branch that does
not exist contradicts a document that names the two that do.

Pull request triggers are left unfiltered, so a PR into `develop` was already building. The gap
was pushes, which is exactly the case a release merge would hit.

## 5. What cannot be done from here

The model is documentation until the repository enforces it. Three settings are outstanding, none
of them reachable from a pull request, all of them under Settings on GitHub. They are listed in
descending order of how much they matter.

1. **Make `develop` the default branch.** This is the one that does the real work. GitHub targets
   new pull requests at the default branch, so while `main` holds that role every contributor who
   does not read `CONTRIBUTING.md` opens their PR against production and someone has to catch it.
   Changing the default makes the correct path the one that requires no knowledge.
2. **Protect `main`**: no direct pushes, require a pull request, require the CI and Conformance
   checks to pass, and restrict who can merge. Without this, "do not merge directly to main" is a
   request rather than a constraint, and the failure mode is silent.
3. **Protect `develop`** more lightly: require the same status checks, allow the people who work
   on the project to merge their own reviewed work.

Until at least the first two exist, this record's status stays provisional.

## 6. Effect on the branches that exist today

`refactor/verifier-list` holds the Part C work and is unmerged. It is based on `4bddd21`, which is
exactly where `develop` starts, so it is already correctly based and needs no rebase — only that
its pull request, when reopened, targets `develop` instead of `main`.

`feat/generate-foundation` is fully contained in `main` apart from one stray `PR_DESCRIPTION.md`.
It predates this model, has no work left in it, and can be deleted once that file is confirmed
unwanted.
