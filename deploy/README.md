# Dual-axis vLLM on one GPU (UI-driven)

Two self-hosted models on a single GPU server, driven from **`/deploy`** in the web UI. There is nothing to run by hand: the web server opens an SSH shell to the GPU host in your browser, uploads each step as a script, and runs it in that shell so you see live output and can press Ctrl+C.

Both endpoints bind `127.0.0.1` only, and `--api-key` is always required. Model defaults and served names live in `packages/harness/src/config/self-hosted.ts` — that file is the single source of truth for the catalog.

**VRAM numbers are never invented.** Measure reads real `nvidia-smi` / vLLM load numbers and writes `/etc/redrob-vllm/measured.env`; the systemd units refuse to start without it. Each measurement is logged to [MEMORY.md](./MEMORY.md).

## Configuration

Set these in the UI at `/settings` (written to the gitignored repo-root `.env`). Never commit real values.

| Variable | Purpose |
| --- | --- |
| `GPU_HOST` | SSH destination |
| `GPU_USER` | SSH user (default `ubuntu`) |
| `GPU_SSH_KEY` | Path to the private key on this machine, read server-side only |
| `GPU_SSH_PORT` | SSH port (default `22`) |
| `HF_TOKEN` | Hugging Face token, used on the GPU host for downloads |
| `VLLM_API_KEY` | Bearer for both endpoints. Auto-issued on first Install if unset |
| `LOCAL_S_PORT` / `LOCAL_L_PORT` | Local tunnel ports (default `8101` / `8102`) |

## Steps on `/deploy`

1. **Install** - creates user `redrob-vllm`, the venv at `/opt/redrob-vllm` (installs vLLM if missing), log dir, systemd units, and `/etc/redrob-vllm/secrets.env`. Does not start serving. Safe to re-run.
2. **Measure** - loads each model alone, reads real VRAM, computes `GPU_MEM_UTIL_*` with headroom, falls back to FP8 for the large axis when weights are too big, verifies both fit together, and writes `measured.env`.
3. **Serve** - `systemctl` start/stop of both units (`Restart=on-failure`, enabled at boot). Start also restarts a running pair so config changes take effect.
4. **Tunnel** - in-process SSH local forwards so Eval reaches the loopback endpoints; sets `VLLM_S_BASE_URL` / `VLLM_L_BASE_URL` for this server process.
5. **Verify** - Health checks readiness plus one short completion. Benchmark measures output tok/s per axis and writes it back into `measured.env`.

The left column shows what has already happened on the host (services, GPU free VRAM, measured utilisation, precision, tok/s), refreshed every 8 seconds.

## Steps keep running if you disconnect

Every step runs inside a persistent `tmux` session named `redrob` on the GPU host, not as a child of the SSH connection. Closing the tab, reloading, losing the network, or restarting the web server does not stop a long Install or Measure.

- Reopening `/deploy` **reattaches** to the same session and picks the output back up mid-flight. It never starts a second shell.
- The output stream is sequence-numbered, so a reconnect replays only what you missed instead of duplicating the log.
- While a step is in flight the host reports it (`/tmp/redrob-op.running`), so the UI shows "Running on the GPU host" and will not let you start it twice.
- **Detach** stops watching and leaves the step running. **End session** kills the tmux session and whatever is running in it.

Install adds `tmux` if the host lacks it. Until then the shell still works, but a step stops when you disconnect, and the UI says so.

## Ports and names

| Slot | Loopback port | Default HF repo | `--served-model-name` |
| --- | --- | --- | --- |
| small | `8101` | `google/gemma-4-E4B-it` | `redrob-s` |
| large | `8102` | `google/gemma-4-31B-it` | `redrob-l` |

Either slot can be pointed at any Hugging Face repo by pasting its link in the UI. Served names stay fixed, so Eval ids do not change when you swap models.

Starting knobs: `max-model-len=8192` (eval-oriented, not the native 256K - see MEMORY.md), `max-num-seqs=8`, bf16 first with an fp8 fallback that Measure records.

## Relative cost in Eval

```
relativeCostWeight(m) = 100 * (tok_per_sec_L / tok_per_sec_m)
```

There is no per-token price for self-hosted models, so cost is relative throughput: the large axis alone is weight 100. Benchmark writes `MEASURED_TOK_PER_SEC_S` / `_L` into `measured.env`, the status poll mirrors them into the running server, and the harness turns them into cost weights. Results carry a caveat, and fp8 is never compared against bf16 without one.

## Where the logic lives

| Path | Role |
| --- | --- |
| `apps/web/src/lib/deploy/ssh.ts` | SSH exec, SFTP, tmux-backed interactive shell (credentials from env only) |
| `apps/web/src/lib/deploy/sessions.ts` | Persistent terminal registry: reattach, sequenced output buffer, detach vs kill |
| `apps/web/src/lib/deploy/remote.ts` | Remote bash: install, start/stop, status, health, benchmark, unit + wrapper templates |
| `apps/web/src/lib/deploy/remote-measure.ts` | Remote VRAM measurement, writes `measured.env` |
| `apps/web/src/lib/deploy/operations.ts` | Builds each step's script, injects it into the shell, mirrors measured values |
| `apps/web/src/lib/deploy/tunnel.ts` | In-process SSH local forwards |
| `apps/web/src/app/api/deploy/*` | status, tunnel, terminal, inject endpoints |
| `apps/web/src/components/DeployApp.tsx` | `/deploy` UI + web terminal |
| `MEMORY.md` | Measurement log |

## Client URLs (through the tunnel)

- small: `http://127.0.0.1:8101/v1` (or `LOCAL_S_PORT`)
- large: `http://127.0.0.1:8102/v1` (or `LOCAL_L_PORT`)
- Header: `Authorization: Bearer` + value of `VLLM_API_KEY`
