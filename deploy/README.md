# Self-hosted vLLM on one GPU (UI-driven, multi-slot)

Up to **two model slots** on a single GPU server (`GPU_HOST`), driven from **`/deploy`**. There is nothing to run by hand: the web server opens an SSH shell to the GPU host in your browser, uploads each step as a script, and runs it in that shell so you see live output and can press Ctrl+C.

Slots share one install root (venv + HF cache + `secrets.env`). Each slot has its own port, systemd unit, serve wrapper, log, and `measured.env`. Sharing one card between slots trades context length and VRAM; prefer **one model per GPU** when the models are large enough that packing hurts quality.

The endpoint listens on `0.0.0.0:($VLLM_PORT + slot)` so this workbench can call the host directly, and `--api-key` is always required. The default base port is the vLLM convention, `8000` (slots → 8000, 8001). Install persistently opens every supported slot port in UFW or firewalld, and every Start reasserts its slot rule. Cloud firewalls such as AWS security groups remain external and must allow the same ports separately. The candidate catalog lives in `packages/harness/src/config/self-hosted.ts`.

**VRAM numbers are never invented.** Measure reads real `nvidia-smi` / vLLM load numbers and writes `/etc/redrob-vllm/slots/<n>/measured.env`; the systemd units refuse to start without it. Util is sized from **remaining free VRAM** so concurrent slots can share a card. Each measurement is logged to [MEMORY.md](./MEMORY.md).

## Where things live on the host

| What | Path / name |
| --- | --- |
| SSH host | `GPU_HOST` (Settings) |
| Install root (shared venv + HF cache) | `/opt/redrob-vllm/` |
| Shared secrets | `/etc/redrob-vllm/secrets.env` |
| Per-slot measured config | `/etc/redrob-vllm/slots/<n>/measured.env` |
| Per-slot unit | `redrob-vllm-s<n>.service` |
| Per-slot wrapper | `/opt/redrob-vllm/bin/serve-<n>.sh` |
| Per-slot log | `/var/log/redrob-vllm/serve-<n>.log` |
| Port | `VLLM_PORT + n` (default 8000, 8001, …) |
| Served model name | `redrob-s<n>` |

## Configuration

Set these in the UI at `/settings` (written to the gitignored repo-root `.env`). Never commit real values.

| Variable | Purpose |
| --- | --- |
| `GPU_HOST` | SSH destination |
| `GPU_USER` | SSH user (default `ubuntu`) |
| `GPU_SSH_KEY` | Path to the private key on this machine, read server-side only |
| `GPU_SSH_PORT` | SSH port (default `22`) |
| `HF_TOKEN` | Hugging Face token, used on the GPU host for downloads |
| `VLLM_API_KEY` | Bearer for the endpoint. Auto-issued on first Install if unset |
| `VLLM_PORT` | Base port for slot 0 (default `8000`); slot n uses `VLLM_PORT + n` |
| `VLLM_BASE_URL` | Where the app calls slot 0. Defaults to `http://localhost:8000/v1`; set it to `http://$GPU_HOST:$VLLM_PORT/v1` for a remote deploy. Extra slots are auto-registered in the vLLM hosts registry on Start. |
| `VLLM_SLOT_URLS` | Optional. `servedName=baseUrl` pairs for hosts where slots are not consecutive ports. |

Local registries (gitignored under `.redrob/`): `deploy-slots.json` (which slots you opened) and `vllm-hosts.json` (endpoints including auto-added slot URLs).

## How Compare finds a deployed model

Compare does not read the registries. It derives every slot endpoint from `VLLM_BASE_URL` (slot n = base port + n, alias `redrob-s{n}`), probes them all, and shows one selectable row per slot that answers. Two deployed models therefore appear as two rows, and each call is routed to its own port by served name. A slot that is not serving fails its probe and is left out rather than shown as a model that scores zero.

## Steps on `/deploy`

1. **Install** (once per host) - creates user `redrob-vllm`, the venv at `/opt/redrob-vllm`, log dir, `/etc/redrob-vllm/secrets.env`, and `/etc/redrob-vllm/slots/`. Migrates a legacy `/etc/redrob-vllm/measured.env` into `slots/0` when present. Seeds slot-0 unit templates. Not enabled until Measure has written that slot's `measured.env`. Safe to re-run.
2. **Add slot** - allocates the next free local slot index (max 2). Each slot card has its own model picker.
3. **Measure** (per slot) - stops only that slot's unit, sizes util from free VRAM, loads the model once, writes `slots/<n>/measured.env`. FP8 is tried once if bfloat16 will not come up.
4. **Serve** (per slot) - `systemctl` start/stop for `redrob-vllm-s<n>.service`. Start enables the unit and rewrites the generated wrapper. On Start, the workbench upserts a vLLM host entry `http://$GPU_HOST:($VLLM_PORT+n)/v1`.
5. **Verify** (per slot) - Health and Benchmark against that slot's port; Benchmark writes tok/s into that slot's `measured.env`.
6. **Undeploy** (per slot) - stop/disable the unit, remove unit file + serve script + that slot's measured.env directory. Does **not** delete the shared venv or HF cache. Clears the local slot record and matching auto-added vLLM host entry.
7. **Remove all models** - Undeploy for every slot in one pass, plus the downloaded weights in `/opt/redrob-vllm/hf-cache`. Keeps the venv and `secrets.env`, so the next Measure only pays for the download.

The left column shows the remote host banner (GPU_HOST, install root, ports) and per-slot status, refreshed every 8 seconds.

## Steps keep running if you disconnect

Every step runs inside a persistent `tmux` session named `redrob` on the GPU host, not as a child of the SSH connection. Closing the tab, reloading, losing the network, or restarting the web server does not stop a long Install or Measure. One terminal is shared across slots; the notice line shows which slot an op targets.

- Reopening `/deploy` **reattaches** to the same session and picks the output back up mid-flight. It never starts a second shell.
- While a step is in flight the host reports it (`/tmp/redrob-op.running`), so the UI shows "Running on the GPU host" and will not let you start it twice.
- **Detach** stops watching and leaves the step running. **End session** kills the tmux session and whatever is running in it.

## Ports and names

| Slot | Port | `--served-model-name` | systemd unit |
| --- | --- | --- | --- |
| 0 | `$VLLM_PORT` (default `8000`) | `redrob-s0` | `redrob-vllm-s0.service` |
| 1 | `$VLLM_PORT+1` | `redrob-s1` | `redrob-vllm-s1.service` |
| … | `$VLLM_PORT+n` | `redrob-s{n}` | `redrob-vllm-s{n}.service` |

Up to `MAX_DEPLOY_SLOTS` (8) on one card. The real limit is free VRAM: Measure sizes each slot from what is left, soft-capped at half the card so the first one cannot swallow it. Ports, units, and status keys all derive from that ceiling in `apps/web/src/lib/deploy/slots.ts`.

Starting knobs: `max-model-len=16384` (also the reply ceiling on vLLM, so a thinking model has room to reason before it answers; not the native 256K - see MEMORY.md), `max-num-seqs=8`, bf16 first with an fp8 fallback that Measure records.

## Relative cost in Eval

```
relativeCostWeight(m) = 100 * (tok_per_sec_large / tok_per_sec_m)
```

Benchmark writes `MEASURED_TOK_PER_SEC` into that slot's `measured.env` and the status poll mirrors a chosen slot (preferring `MEASURED_MODEL_HF` match, else most recently measured) into the running server.

## Where the logic lives

| Path | Role |
| --- | --- |
| `apps/web/src/lib/deploy/slots.ts` | Slot paths/ports/names + local `.redrob/deploy-slots.json` |
| `apps/web/src/lib/deploy/ssh.ts` | SSH exec, SFTP, tmux-backed interactive shell |
| `apps/web/src/lib/deploy/sessions.ts` | Persistent terminal registry |
| `apps/web/src/lib/deploy/remote.ts` | Remote bash: install, start/stop/undeploy, status, health, benchmark |
| `apps/web/src/lib/deploy/remote-measure.ts` | Remote VRAM measurement per slot |
| `apps/web/src/lib/deploy/operations.ts` | Builds each step's script, injects it, mirrors measured values, syncs hosts |
| `apps/web/src/app/api/deploy/*` | status, slots, terminal, inject, cancel |
| `apps/web/src/components/DeployApp.tsx` | `/deploy` UI + web terminal |
| `MEMORY.md` | Measurement log |

## Client URL

- Slot n: `http://$GPU_HOST:($VLLM_PORT+n)/v1`
- Header: `Authorization: Bearer` + value of `VLLM_API_KEY`
- Model: `redrob-s<n>`
