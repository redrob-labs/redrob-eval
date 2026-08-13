# Is that difference real?

Two accuracy numbers side by side invite exactly one question, and a point
estimate cannot answer it. At the sizes these evals run at, the intuitive answer
is usually wrong: 81 items is plenty to separate 60% from 95% and nowhere near
enough to separate 91% from 94%.

```bash
yarn compare-runs --run <id>                    # metric defaults to toolSelect
yarn compare-runs --run <id> --metric absence
yarn compare-runs --run <id> --metric parsed --json out.json
```

## What it reports, and why each piece

**Wilson score intervals**, not the normal approximation. At the denominators
these slices actually have — an absence rate over 13 items — `p ± z·sqrt(p(1-p)/n)`
produces bounds below zero or above one, and is worst exactly where p is near 0
or 1, which is where most of these rates sit.

**McNemar's exact test**, because the comparison is paired: every model answers
the same items. Only the *disagreements* carry information — items both models
got right, or both got wrong, say nothing about which is better. The exact
binomial form is used rather than chi-square because the discordant counts here
are routinely single digits, where the approximation is not trustworthy.

**A paired bootstrap interval** for the difference. Items are resampled, not
scores: a resample draws an item and takes *both* models' outcomes on it, because
the pairing is the thing that was expensive to arrange. It is **seeded**, so the
interval is identical on re-run — one that moves cannot go in a paper.

**Holm-Bonferroni adjustment** across the pairs in one call. Six models is
fifteen tests, and at that point one p under 0.05 is expected from noise alone.
Holm rather than plain Bonferroni because it is uniformly more powerful at the
same guarantee.

**Power warnings**, printed next to the result rather than left to the reader.
The failure mode is not a wrong number; it is a true number that cannot carry the
weight put on it.

## Why this exists, in one real example

A matrix over three sub-10B models reported these tool-selection rates:

| model | rate |
| --- | --- |
| llama-3.2-3b | 100% |
| ministral-3b-2512 | 90% |
| qwen-2.5-7b | 90% |

Read as a leaderboard, Llama won. The comparison says otherwise:

```
| model             | rate | 95% interval | n  |
| llama-3.2-3b      | 100% | 44%–100%     | 3  |
| ministral-3b-2512 |  90% | 70%–97%      | 20 |
| qwen-2.5-7b       |  90% | 70%–97%      | 20 |

! llama vs ministral: only 3 shared item(s) … the models never disagreed
```

Llama's 100% is over **three items** — the other 21 never reached the tool-select
metric because they failed to parse, and a metric skips the items it does not
apply to. Switching metric finds the real story:

```
yarn compare-runs --run <id> --metric parsed
| ministral-3b-2512 | 100% | 86%–100% | 24 |
| qwen-2.5-7b       | 100% | 86%–100% | 24 |
| llama-3.2-3b      |  25% | 12%–45%  | 24 |

+75% [58%–92%], 18 disagreements, p (adjusted) = 0.000
```

*That* difference is real. The first table's leader was an artefact of a tiny
denominator, which is precisely what a bare accuracy column cannot show you and
what this is for.

## Related

- [Failure analysis](failure-analysis.md) — what those parse failures actually were
- [Resumable job queue](job-queue.md) — running the grid the comparison reads
