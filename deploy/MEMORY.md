# Self-hosted vLLM VRAM / serving notes

## Status

**NOT MEASURED** - no GPU host was available at authoring time.

Every number here comes from the **Measure** and **Benchmark** steps on `/deploy`.
**Do not hand-write MiB, util fractions, or tok/s.**

## Procedure (all from `/deploy`)

Everything runs over SSH from the web UI; there are no shell scripts to run by hand.
Logic lives in `apps/web/src/lib/deploy/` (see [README.md](./README.md)).

1. Set `GPU_HOST`, `GPU_USER`, `GPU_SSH_KEY`, `HF_TOKEN` in `/settings`. `VLLM_API_KEY` is issued automatically on first Install.
2. **Install** - creates user, venv, the unit, secrets. Does not start serving.
3. **Measure** (`remote-measure.ts`):
   - Stops the unit, plus the two per-axis units a host provisioned earlier may still have, so the reading is not polluted by something already resident.
   - Starts **the one model being deployed** at `min(free/total, 0.50)` minus headroom, bf16, `--max-model-len 16384`, `--max-num-seqs 8`. That probe deliberately loads big: it is how the cost per token gets observed. Free VRAM is re-read **at each load attempt**, never once at the top: measuring one slot while another was restarting saw 84 GiB free, asked for half the card, and vLLM refused by the time it allocated ("Free memory on device cuda:0 is less than desired GPU memory utilization"). That looked like a 350M model being too big for an idle card. Losing that race retries against current free VRAM instead of spending the FP8 fallback on it.
   - Then **sizes the served slot down to that answer.** vLLM turns `--gpu-memory-utilization` into a static KV pool, so a 2B model measured on a free card reserved 41 GiB of KV for 3.2M tokens when the workload only ever needs `max_model_len x max_num_seqs`. Two slots filled a 96 GiB card and the third could not load. Measure reads `Available KV cache memory`, `GPU KV cache size`, and the `Actual usage is …` breakdown out of the probe log, and records `KV_CACHE_MEMORY` (bytes, workload tokens x 1.25) plus the `GPU_MEM_UTIL` that footprint implies. Serve passes `--kv-cache-memory`, so slots keep fitting while there is memory. The probe's own util is kept as `PROBE_GPU_MEM_UTIL` for provenance.
   - There is no separate sizing pass: a lone model gets that util whatever it weighs, so a first load could only tell us what the real one already does.
   - Waits for readiness, streaming vLLM's own output (download, load, warmup) into the pane, and records `nvidia-smi` memory.used / free plus the weight GiB the log reports.
   - If bf16 will not come up, retries **once** with `--quantization fp8`. Only on failure: a retry that is not needed costs another cold start.
   - Runs a short completion, because a model that loads and does not answer has not been measured.
   - Writes `/etc/redrob-vllm/measured.env` whole. Nothing is carried over: every key in it describes the weights that were on the card. **No invented util values.**
4. **Serve** → **Health** → **Benchmark**.

The service **refuses to start** without `/etc/redrob-vllm/measured.env` (required `EnvironmentFile=`; the serve wrapper requires `GPU_MEM_UTIL`).

The status poll mirrors `measured.env` into the running web server and appends a dated block to the log at the bottom of this file, once per distinct measurement.

## Why `max-model-len=16384`

Eval tasks here are short-to-medium context, but `max-model-len` doubles as the reply ceiling on vLLM (the adapter omits `max_tokens`). At 8192 a thinking model spent the whole budget reasoning and was cut off before it answered ("Cut off inside the reasoning trace before any answer"), so the cap is 16384 to give the trace room. Native 128K/256K stays off the table: the KV pool would dominate VRAM and a slot on a shared card can fail to come up. Raise further only when a slot has the card to itself and a new measurement pass confirms the KV cache still fits.

## CPU bottleneck guidance (8 vCPU)

On hosts with ~8 vCPUs, token generation is often **CPU-bound** (scheduler, tokenizer, sampling) before the GPU saturates - especially with `max-num-seqs` raised aggressively.

- Start at `max-num-seqs=8`; only increase after Benchmark and `nvidia-smi` show GPU headroom while CPU is not pegged.
- Measure tok/s with the same `max-num-seqs` used in the production units.
- If CPU sits at 100% while GPU util is modest, lowering seqs or batch pressure helps more than raising `gpu-memory-utilization`.

## Relative cost (Eval)

```
relativeCostWeight(m) = 100 * (tok_per_sec_large / tok_per_sec_m)
```

A large model alone defines weight 100. Only the model currently behind the endpoint has a measured tok/s; the dated blocks at the bottom of this file are where earlier ones are kept, since `measured.env` is rewritten on every Measure. See the Benchmark step and `packages/harness/src/config/self-hosted.ts`.

## Two failures that look like the model and are not

- **Install says OK, Measure stays blocked.** The status check runs as the login
  user, not root. The secrets `umask 077` used to leak into `python3 -m venv`,
  leaving `/opt/redrob-vllm/venv` at `0700`, so the check could not see vLLM and
  reported it as never installed. The umask is scoped now and Install ends with
  `chmod -R a+rX` on the venv.
- **Measure finishes, Serve stays blocked.** Same shape: `measured.env` was
  written `0640 root:redrob-vllm`, so the status check read nothing out of it
  and the UI saw a model with no measured util. It holds sizes, not secrets, so
  it is `0644` now, and Install repairs an existing one.
- **The weights load, then the engine dies on `FileNotFoundError: 'ninja'`.**
  flashinfer JIT-compiles kernels on the first load and shells out to a bare
  `ninja`, which only exists in the venv. Calling `venv/bin/vllm` by path does
  not put the venv on `PATH`, so both the probe and the unit now set it.

## Bind / auth

- vLLM listens on `0.0.0.0:$VLLM_PORT`, so the workbench calls the host directly. The
  SSH forward that used to stand in for this is gone.
- `--api-key` always required (`VLLM_API_KEY`), and with an open port it is the
  only thing guarding the endpoint. Keep the port closed to everything but the
  machines you run the workbench from.

## Append-only measurement log

*(The status poll appends dated blocks below - do not hand-edit fake numbers.)*

## Measurement 2026-08-11T06:59:38Z
<!-- measurement: 2026-08-11T06:59:38Z Qwen/Qwen3.5-4B tok/s  slot 0 -->

| Field | Value |
| --- | --- |
| GPU name / total MiB | NVIDIA RTX PRO 6000 Blackwell Server Edition / 97887 |
| HF repo | Qwen/Qwen3.5-4B |
| slot | 0 |
| served as | redrob (:8101) |
| dtype / quantization | bfloat16 / none |
| weight MiB | 8816 |
| gpu-memory-utilization | 0.8800 |
| max-model-len | 8192 |
| free MiB after load | 12694 |
| tok/s |  |

