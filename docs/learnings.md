# Learnings (living log)

Append dated notes as we collect data and train routers. Keep entries short and evidence-based.

---

## 2026-07-27 — Repo purpose lock-in

- **Purpose**: open-source evolution harness for Indic LLM configs; routing dual-eval is one data path for an optional routing SLM.
- **Heuristic complexity ≠ good labels.** Early `oracle %` against “small scored ≥ 0.99 ⇒ should be small” exposed that length/keyword heuristics disagree with outcomes (e.g. ~25% agreement on some GSM8K slices).
- **Dual-eval first.** Always call small *and* large per sample, then label. Replay heuristic/oracle/cascade offline for Pareto without extra provider spend.
- **Persist everything.** Text routing runs must hit disk (`eval/routing-runs/`, `eval/routing-corpus/`). Session-only results cannot train a model.
- **No gold in features.** Training inputs are query + task/metadata features only; gold is for scoring/labels only.
- **Image preference** is complementary product eval; routing corpus is text dual-eval.
- **Open-source constraints**: relative cost weights only; exclude Krea/NSFW; keys stay server-side.

### Next measurements to log

- Save rate (`label=small` fraction) by dataset
- Heuristic agreement with oracle by task
- Quality retention of oracle vs large alone
- Relative cost % of oracle vs large alone
- After SLM v0: same metrics vs oracle gap

---

## 2026-07-27 — Router input cost (full task tokens)

**Question:** If the routing SLM sees the entire user task, aren’t we burning tokens anyway?

**Answer:** Yes for *input length*, no for *relative spend* — if the router’s relative cost weight is much lower than the large model’s.

- Dual-eval labels teach “will small be good enough?”
- At inference, cost ≈ `router(input) + chosen_model(input [+ gen])`
- Savings only appear when:
  1. router relative weight ≪ large relative weight (true SLM / classifier), and
  2. enough traffic is labeled `small`, and
  3. router overhead ≪ expected large savings

**Mitigations (prefer in order):**

1. **Feature-only / embedding router** — no full text to an LLM; use length, digits, task, embedding kNN/MLP. Cheapest.
2. **Truncated prompt** — first N chars / first sentence + task tag to the SLM.
3. **Full-text tiny SLM** — acceptable when router weight ≪ large (e.g. 0.5B–3B vs 70B+/frontier).
4. **Avoid** a full-text router whose relative weight is near the large model — then routing barely helps.

**Corpus implication:** keep exporting both `flat` (features) and `chat` (full/truncated text) so we can train either style and compare router-overhead vs save-rate on Pareto.

---

## 2026-07-27 — Train both MLP and SLM

**Decision:** Build both learners on the same outcome labels.

- **MLP (features)** = default router candidate (low token overhead).
- **LoRA SLM (chat JSONL)** = comparison arm; use when feature router plateaus.
- Tooling under `train/`: `mlp_train.py`, `slm_train.py`, `compare.py`, fixtures for smoke.
- Do not pick a winner until `compare.py` accuracy + (later) Pareto cost/quality on held-out dual-eval.

---

## Template for new entries

```md
## YYYY-MM-DD — title

- Setup: dataset, n, small, large, threshold
- Save rate / heuristic-agree / oracle quality / oracle cost%
- What surprised us
- Decision / follow-up
```
