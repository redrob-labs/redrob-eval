# Dual-axis vLLM VRAM / serving notes

## Status

**NOT MEASURED** - no GPU host was available at authoring time.

Every number here comes from the **Measure** and **Benchmark** steps on `/deploy`.
**Do not hand-write MiB, util fractions, or tok/s.**

## Procedure (all from `/deploy`)

Everything runs over SSH from the web UI; there are no shell scripts to run by hand.
Logic lives in `apps/web/src/lib/deploy/` (see [README.md](./README.md)).

1. Set `GPU_HOST`, `GPU_USER`, `GPU_SSH_KEY`, `HF_TOKEN` in `/settings`. `VLLM_API_KEY` is issued automatically on first Install.
2. **Install** - creates user, venv, units, secrets. Does not start serving.
3. **Measure** (`remote-measure.ts`):
   - Stops both units.
   - Starts the **large axis alone** with provisional `--gpu-memory-utilization 0.9`, bf16, `--max-model-len 8192`, `--max-num-seqs 8`.
   - Waits for readiness, records `nvidia-smi` memory.used / memory.total, scrapes weight GiB from the vLLM log when present.
   - Stops it; repeats for the **small axis alone**.
   - If the large weight fraction is above ~75% of total VRAM (too little left for the small axis + KV), retries with `--quantization fp8` and remeasures.
   - Computes `GPU_MEM_UTIL_*` from measured MiB vs total so weights plus KV leave ~10-15% free. **No invented util values.**
   - Starts both with the computed utils, checks free memory > 0, runs short completions.
   - Writes `/etc/redrob-vllm/measured.env` on the host.
4. **Serve** → **Tunnel** → **Health** → **Benchmark**.

Services **refuse to start** without `/etc/redrob-vllm/measured.env` (required `EnvironmentFile=`; the serve wrappers require `GPU_MEM_UTIL_*`).

The status poll mirrors `measured.env` into the running web server and appends a dated block to the log at the bottom of this file, once per distinct measurement.

## Why `max-model-len=8192`

Eval tasks here are short-to-medium context. Shipping native 128K/256K context allocates a huge KV pool and starves dual-load on one card. 8192 is the eval-oriented starting cap; Measure may lower it further if KV is still tight after weight measurement. Do not raise it toward the native max without a new measurement pass.

## CPU bottleneck guidance (8 vCPU)

On hosts with ~8 vCPUs, token generation is often **CPU-bound** (scheduler, tokenizer, sampling) before the GPU saturates - especially with `max-num-seqs` raised aggressively.

- Start at `max-num-seqs=8`; only increase after Benchmark and `nvidia-smi` show GPU headroom while CPU is not pegged.
- Measure tok/s with the same `max-num-seqs` used in the production units.
- If CPU sits at 100% while GPU util is modest, lowering seqs or batch pressure helps more than raising `gpu-memory-utilization`.

## Relative cost (Eval)

```
relativeCostWeight(m) = 100 * (tok_per_sec_L / tok_per_sec_m)
```

Large-alone throughput defines weight 100. See the Benchmark step and `packages/harness/src/config/self-hosted.ts`.

## Bind / auth

- vLLM listens on `127.0.0.1` only (never `0.0.0.0`).
- `--api-key` always required (`VLLM_API_KEY`).
- Reached from this machine through the Tunnel step, not an open port.

## Append-only measurement log

*(The status poll appends dated blocks below - do not hand-edit fake numbers.)*
