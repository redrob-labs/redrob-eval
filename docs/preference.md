# Blind preference in Compare

Some tasks have no reference answer. Open-ended writing, summarization, and every
image prompt fall in that bucket: there is nothing to score against, so the
ranking has to come from a human. Compare's preference stage is where that
happens, and its output feeds routing.

## Why a bracket instead of a rating scale

Absolute 1-10 ratings drift between sessions and between raters. Pairwise choice
does not: "which of these two is better" is a question a person answers
consistently. A single-elimination bracket is the cheapest way to turn pairwise
choices into a ranking - `n` models need `n - 1` votes per prompt instead of the
`n(n-1)/2` a full round robin would cost.

The tradeoff is honest to state: a bracket finds a winner, not a full ordering.
Two strong models that meet in round one produce one loss for a model that might
be second best overall. That is why the standings report head-to-head wins and
prompts-won separately, and why the routing labels below look at the direct
matchup rather than only the champion.

## How a bracket is built

One bracket per prompt. The competitors are the models' answers to *that* prompt,
so a match is two answers to the same question side by side.

- Seeding is deterministic from the model ids, so the same run rebuilds the same
  bracket.
- Fields that are not a power of two are padded with byes in the first round.
- A model that errored on that prompt loses by walkover. No human is asked to
  compare an answer against a stack trace.
- A tie is recorded as a tie in the vote log and advances side A, so the bracket
  can still finish.

Model identity is hidden on the vote cards until the round resolves. The voter
sees "A" and "B" and the answer, which is the point: the vote should measure the
output, not the brand.

## Scale

Resolving a ~20-point Elo gap between two models at 95% confidence needs on the
order of **thousands of pairwise votes** on that pair. A bracket over a handful
of prompts is a decision aid for one team's task, not a public leaderboard. Read
the standings as "which of these carried my prompts", not as a rating.

## Model judges

For image, a match can be handed to a vision judge (`Let the judge decide`),
which records the verdict as an ordinary vote. Use it to get through a long
bracket, and override it by voting the rest yourself - the vote log keeps every
decision either way. Text is human-only today.

## Storage

`eval/tournaments/{runId}/`:

- `meta.json` - the tournament meta plus every bracket's current state
- `votes.jsonl` - append-only, one vote per line, so a crash mid-session loses
  nothing

Rater identity is never recorded. There are no names, emails, IPs, or free-text
fields that could carry identity - only the match, the pick, and a timestamp.

## From votes to routing

The optimize-route stage asks for a fast model and a fallback. Per prompt:

- the fast model beat or tied the fallback head to head → label `small`
- the fast model errored, lost the matchup, or the bracket is unresolved → `large`

These become ordinary `RoutingExample` rows, so the corpus, replay and
`/api/routing/export` paths are untouched. The only thing that changed is where
the supervision came from: a person's preference instead of a metric threshold.
The reported **save rate** is the fraction of prompts the fast model can carry.

## API

- `POST /api/compare/tournament` - build brackets from a Compare run's answers
- `GET /api/compare/tournament/:id` - meta, brackets, votes, standings
- `POST /api/compare/tournament/:id/vote` - `{ promptId, matchId, winner }`
- `POST /api/compare/tournament/:id/judge` - model judge decides one match
- `POST /api/compare/tournament/:id/route-policy` - `{ smallModelId, largeModelId, save }`

Offline check:

```bash
yarn verify:tournament
```

## Headless generation matrix

`/api/preference/runs` still exists for scripted K-models × M-inputs generation
against a Custom Goal, with identical generation params per run, verbatim
`finishReason`, and a `truncationWarning` when any model hit its token cap.
It has no UI - Compare's run stage covers the same ground interactively. Verify
with `yarn verify:preference-gen`.

## Related

- [Methodology](methodology.md) - routing labels, features, export
