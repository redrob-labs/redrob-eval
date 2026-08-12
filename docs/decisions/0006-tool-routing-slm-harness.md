# 0006 Tool-routing SLM harness

- **Status:** accepted
- **Date:** 2026-08-10

## Context

We need to compare small open models on a fixed-toolset routing task
(EN / HI / Hinglish / KO) under a couple of output constraints, without touching
the existing text-benchmark or small/large routing-data paths.

## Decision

1. Add a separate module `packages/harness/src/lib/tool-routing/` with its own
   model registry (`license` + `usable: true | eval_only`).
2. Implement the `grammar` condition with **vLLM guided decoding**
   (`extraBody.guided_grammar`, EBNF). Do not add a llama.cpp backend in this
   change. OpenAI-compat gets the same `extraBody` passthrough but is unused here.
3. Report shape `redrob-tool-routing/v1` always includes condition **deltas** and
   the disclaimer that vLLM EBNF may differ from llama.cpp GBNF.
4. CPU latency fields exist and stay `null`; only GPU latency is measured.
5. Fertility is tokenizer-only (no inference), relative to Qwen3-0.6B = 1.0.
   The tokenizer comes from Hugging Face at measure time and is cached on disk;
   when it cannot be loaded the cell is `measured: false` with zeroed counts.
   `measureFertility`'s character-heuristic fallback is deliberately not used
   here, because an estimate printed next to measurements reads as one.
6. A run is gated on probing `GET {baseUrl}/models`, not on `VLLM_API_KEY`
   being present. `/api/tool-routing/run` repeats the probe server-side and
   returns 503 (endpoint down) or 409 (endpoint does not serve that name)
   before spending any call.
7. Endpoints come from a registry, not only from an env var. The endpoint Deploy
   manages stays a read-only built-in, since `VLLM_BASE_URL` already names it;
   user-added hosts live in the gitignored `.redrob/vllm-hosts.json` with an
   optional per-host key that falls back to `VLLM_API_KEY`. Clients pass a host
   **id** and the server resolves the URL, so a browser cannot aim a
   server-side fetch at an address of its own.
8. Deploy serves exactly one model, never a co-resident pair. Comparing
   candidates means swapping the served model and running the harness again, so
   pairing a small model with a large one only forced a download the comparison
   never used, and splitting the card between them cost both of them context
   length. Consequences: the model takes whatever the headroom leaves, which
   makes the solo sizing pass redundant (one load answers both "how big is it"
   and "does it come up", with FP8 tried once if bfloat16 will not start); and
   Measure rewrites `measured.env` whole, because every value in it describes
   the weights that were on the card.
9. There is no S/L axis: one port, one unit, one served name, `redrob`. The
   split existed to keep two co-resident models apart, and once only one is
   served it was two of everything for one thing, plus a name that had to change
   whenever you swapped model size. The eval catalog now carries a single
   self-hosted row for the endpoint, and `applyMeasuredThroughput` fills in the
   label and throughput from the `MODEL_HF` the host reports. Small and large
   survive only as `tier` on the deploy candidates, which groups the picker and
   sets the eval tier. Throughput is attributed to the benchmarked repo rather
   than to every candidate of the same size, since a 0.6B and a 4B do not share
   a tok/s. Install removes the two old units, which would otherwise claim the
   card at boot.
10. A served name is only an alias, so matching it does not prove which weights
    answer a call. vLLM reports its launch argument as `root` on `/v1/models`,
    and both the setup and `/api/tool-routing/run` compare it to the candidate's
    `hfRepoId`, returning 409 on a disagreement. The alternative was a report
    filed under a model that never ran, which is worse than no report.
11. The endpoint, not `SELF_HOSTED_DEFAULTS`, names the self-hosted row in the
    Compare catalog. The default is a plan about the deploy slot, and swapping
    the model on /deploy used to leave every result labelled with the old one.
    `/api/models` reads `root` back (cached 60s, 20s while down) and an
    unreachable endpoint makes the row unselectable rather than merely unlabelled.
12. Deploy can serve a repo the research registry never listed, so the tool
    routing picker offers it as a `served:<org>/<repo>` candidate filed under the
    real repo id. Restricting runs to the registry would have made "test the
    model I deployed" impossible; the weights check in 10 is what keeps the
    stand-in honest, since it is only accepted while the endpoint confirms it.
13. LFM2.5 carries the LFM Open License v1.0, whose commercial grant lapses at
    $10M annual revenue. That is a third license class: unlike cc-by-nc it is
    commercially usable, so it is deployable and in the default run set, with the
    threshold repeated in every candidate note rather than encoded as a flag.
14. The `grammar` condition is dropped, superseding 2 and 3. Guided decoding is
    a vLLM feature, so a hosted model could never enter that column, and a
    comparison half the field cannot take part in is not one. Every remaining
    condition is plain prompting, which removes the per-provider condition gate,
    the EBNF builder and the llama.cpp disclaimer with it. Report shape is
    `redrob-tool-routing/v2`: no `disclaimer`, and the only delta is
    contract − bare.
15. Scenarios come in three named toolsets. `core` is the original six tools;
    `wide` is eighteen, adding a near neighbour of each right answer
    (`track_shipment` beside `lookup_order`, `send_sms` beside `send_email`,
    `convert_units` beside `convert_currency`); `full` is fifty tools across
    many domains (maps, payments, contacts, notes, and similar). With six
    tools a model can be right by elimination, which flatters it, so accuracy
    is also read split by toolset. The toolset is named on the task and resolved
    at load time, since inlining fifty JSON Schemas into each task would be
    thousands of lines of copies.
16. A reasoning trace is stripped before scoring, and local runs omit the reply
    token cap. Some models cannot be talked out of thinking: LFM2.5-2.6B's
    template opens `<think>` itself, so neither
    `chat_template_kwargs.enable_thinking` nor `reasoning_effort` reaches it.
    The old 256-token cap then ran out inside the block on 5 of 17 sampled
    tasks, and the trace routinely rehearses the JSON it is about to emit, which
    left two objects in one reply. Both were filed as parse failures, so the
    report was measuring the cap and the parser rather than the router. The
    parser now reads only what follows the last `</think>` and takes the last
    complete top-level object. On vLLM the request omits `max_tokens` and lets
    the server stop; hosted providers still get a 2048 ceiling so an unbounded
    call does not become a bill.
17. Compare runs only the `contract` condition. In practice, bare prompting
    failed to produce usable router output across local and frontier models, so
    spending half the run on it added empty deltas rather than a useful
    comparison. New reports contain absolute contract metrics by model and
    language. The bare prompt builder and v2 delta reader remain for old reports
    and offline experiments.
18. Deploy may run several slots on one GPU host, each with its own port,
    unit, and served name (`redrob-s{n}`). The earlier "exactly one model"
    rule in 8–9 is superseded for co-resident candidates: Measure sizes each
    slot from free VRAM and from the probe's own KV cost so later slots still
    fit, and the live catalog probes every derived slot port. A single-slot
    install remains valid.
19. A reply that puts the tool name in `action` instead of `tool` is still a
    parse failure (the contract asked for one shape). The parser keeps the
    intended call as `envelope`, and reports count those separately so a model
    that routes correctly into the wrong key is not read as unable to route.

## Consequences

- `eval_only` (cc-by-nc) models never enter the default run set.
- Evaluation-set generation remains out of scope; fixtures are stubs.
- An unreachable endpoint fails as an endpoint error. It can no longer produce
  a complete-looking report of 0% accuracy and 100% parse failures, which would
  read as a measurement of the model.
- Local reasoning models cost more wall time per task once the cap is gone.
  That is the price of scoring them on their answer instead of on where their
  budget ran out. Hosted runs still pay a token ceiling.
- A parse failure still leaves tool selection unscored, so accuracy is read over
  the replies that parsed. Read it next to the parse failure and wrong-envelope
  columns: a model that answers `{"action":"send_sms",...}` instead of
  `{"tool":"send_sms",...}` broke the contract, and that shows up there rather
  than as a wrong tool.
- Multi-slot hosts must keep every slot port reachable from the workbench.
  Host firewall rules are opened on Install and reasserted on Start; cloud
  security groups remain an external step.
