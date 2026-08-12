import { INSTALL_ROOT, LEGACY_UNIT, slotFor, type DeploySlot } from './slots';

/**
 * Self-contained remote measurement (root) behind the Measure step on /deploy.
 *
 * One slot at a time: stops only that slot's unit, leaves other slots running,
 * sizes util from remaining free VRAM (vLLM util is a fraction of total), and
 * writes /etc/redrob-vllm/slots/<n>/measured.env. Prints RESULT_* lines for the
 * server to parse.
 *
 * FP8 is tried once, and only when bfloat16 fails to come up, because a retry
 * that is not needed costs another cold start.
 *
 * Never invents util/MiB. Requires secret env: VLLM_API_KEY, HF_TOKEN.
 */
export interface MeasureParams {
  model: string;
  servedName: string;
  maxModelLen: number;
  maxNumSeqs: number;
  headroomFrac?: number;
  readyTimeoutSec?: number;
  /** Slot to measure; defaults to 0. */
  slot?: DeploySlot | number;
}

function asSlot(slot?: DeploySlot | number): DeploySlot {
  if (typeof slot === 'object' && slot !== null) return slot;
  return slotFor(typeof slot === 'number' ? slot : 0);
}

export function measureScript(p: MeasureParams): string {
  const headroom = p.headroomFrac ?? 0.12;
  const readyTimeout = p.readyTimeoutSec ?? 900;
  const s = asSlot(p.slot);

  return `set -uo pipefail
export HF_TOKEN="\${HF_TOKEN:-}"
export HUGGING_FACE_HUB_TOKEN="\${HF_TOKEN:-}"
export HF_HOME="${INSTALL_ROOT}/hf-cache"

PROBE_LOG_DIR="/tmp/redrob-vllm-measure"
VENV_BIN="${INSTALL_ROOT}/venv/bin"
VLLM_BIN="\${VENV_BIN}/vllm"
# flashinfer compiles kernels at startup and shells out to a bare "ninja", which
# only exists in the venv. Calling the vllm binary by path does not put the venv
# on PATH, so the load died on FileNotFoundError after the weights were already
# on the card.
PROBE_PATH="\${VENV_BIN}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
# sudo -E hands the probe root's HOME, so vLLM, torch and triton all try to
# cache under /root/.cache and die on permission. The units get this right from
# passwd, so take the same home from there.
SERVICE_HOME="$(getent passwd redrob-vllm 2>/dev/null | cut -d: -f6)"
SERVICE_HOME="\${SERVICE_HOME:-${INSTALL_ROOT}}"
READY_TIMEOUT_SEC=${readyTimeout}
HEADROOM_FRAC=${headroom}
MAX_LEN=${p.maxModelLen}
MAX_SEQS=${p.maxNumSeqs}
PORT=${s.port}
SLOT=${s.index}
MODEL='${p.model}'
SERVED='${p.servedName}'
MEASURED_ENV='${s.measuredEnv}'
UNIT='${s.unit}'
mkdir -p "\${PROBE_LOG_DIR}"
chmod 755 "\${PROBE_LOG_DIR}"
# The probes drop to the redrob-vllm service account, which cannot read a login
# home such as /home/ubuntu. vLLM resolves the model id against the cwd before
# it asks the Hub, so an unreadable cwd surfaces as "Invalid repository ID".
# Run from a directory every account can traverse.
cd "\${PROBE_LOG_DIR}"

gpu_total() { nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -n1 | tr -d ' '; }
gpu_used()  { nvidia-smi --query-gpu=memory.used  --format=csv,noheader,nounits | head -n1 | tr -d ' '; }
gpu_free()  { nvidia-smi --query-gpu=memory.free  --format=csv,noheader,nounits | head -n1 | tr -d ' '; }
gpu_name()  { nvidia-smi --query-gpu=name --format=csv,noheader | head -n1; }

FOLLOW_PID=""
# Mirror the probe log into the pane while we wait. Raw, with no filter in the
# pipe: weight downloads and warmup report with carriage returns, and anything
# line buffered would hold them back until the transfer finished.
start_follow() {
  local port="$1"
  stop_follow
  echo "---- live vLLM output on \${port} (download, load, warmup) ----"
  tail -n +1 -F "\${PROBE_LOG_DIR}/probe-\${port}.log" 2>/dev/null &
  FOLLOW_PID=$!
}
stop_follow() {
  [[ -z "\${FOLLOW_PID:-}" ]] && return 0
  kill "\${FOLLOW_PID}" 2>/dev/null || true
  wait "\${FOLLOW_PID}" 2>/dev/null || true
  FOLLOW_PID=""
  echo ""
  echo "---- end of live output ----"
}
kill_probe() {
  local port="$1"
  stop_follow
  if [[ -f "\${PROBE_LOG_DIR}/pid-\${port}" ]]; then
    local pid; pid="$(cat "\${PROBE_LOG_DIR}/pid-\${port}")"
    kill "\${pid}" 2>/dev/null || true
    wait "\${pid}" 2>/dev/null || true
    rm -f "\${PROBE_LOG_DIR}/pid-\${port}"
  fi
  command -v fuser >/dev/null 2>&1 && fuser -k "\${port}/tcp" 2>/dev/null || true
  sleep 2
}
# Only this slot (plus the pre-multi-slot unit) is stopped. Other slots keep
# running so util is sized against remaining free VRAM.
stop_this_slot() {
  systemctl stop "\${UNIT}" ${LEGACY_UNIT} 2>/dev/null || true
  # Old two-axis units, if somehow still present.
  systemctl stop redrob-vllm-s.service redrob-vllm-l.service 2>/dev/null || true
  kill_probe ${s.port}; sleep 2
}
# Ctrl+C or a Stop from the UI must not leave a probe holding the GPU, or the
# next attempt fails on memory that nothing appears to be using.
on_interrupt() {
  trap - INT TERM
  echo ""
  stop_follow
  echo "[redrob] interrupted - shutting down probes"
  kill_probe ${s.port}
  echo "[redrob] probes stopped; GPU released"
  exit 130
}
trap on_interrupt INT TERM
# Any exit path, including the error ones, must take the follower with it or the
# pane keeps printing after the step is over.
trap stop_follow EXIT
scrape_weight_gib() {
  local log="$1"; local line
  line="$(grep -Eo 'Model loading took [0-9.]+ (GiB|GB)' "\${log}" 2>/dev/null | tail -n1 || true)"
  [[ -z "\${line}" ]] && { echo ""; return 0; }
  echo "\${line}" | grep -Eo '[0-9.]+' | head -n1
}
dump_probe_log() {
  local port="$1"; local log="\${PROBE_LOG_DIR}/probe-\${port}.log"
  # vLLM's tail is the outer traceback and says "see root cause above", so pull
  # the exception lines out first. The real reason is usually far up the file.
  echo "---- root cause candidates in \${log} ----" >&2
  grep -nE '([A-Za-z_]+(Error|Exception)|CUDA out of memory|Killed|No space left)' "\${log}" 2>/dev/null \\
    | grep -vE 'ERROR [0-9]' | tail -n 8 | sed 's/^/  ! /' >&2 || true
  echo "---- last 40 lines of \${log} ----" >&2
  tail -n 40 "\${log}" 2>&1 | sed 's/^/  | /' >&2 || true
  echo "---- end of \${log} ----" >&2
}
# A reaped child still has a pid, so treat a zombie as gone.
probe_alive() {
  local pid="$1"; [[ -z "\${pid}" ]] && return 1
  local st; st="$(ps -p "\${pid}" -o stat= 2>/dev/null | tr -d ' ')"
  [[ -n "\${st}" && "\${st}" != Z* ]]
}
wait_ready() {
  local port="$1"; local deadline=$(( SECONDS + READY_TIMEOUT_SEC ))
  local pidfile="\${PROBE_LOG_DIR}/pid-\${port}" pid="" spoke=0 waited=0
  [[ -f "\${pidfile}" ]] && pid="$(cat "\${pidfile}" 2>/dev/null)"
  while (( SECONDS < deadline )); do
    if curl -sf -H "Authorization: Bearer \${VLLM_API_KEY}" "http://127.0.0.1:\${port}/v1/models" >/dev/null 2>&1; then
      stop_follow
      return 0
    fi
    # No point waiting out the timeout once the server is gone.
    if [[ -n "\${pid}" ]] && ! probe_alive "\${pid}"; then
      stop_follow
      echo "ERROR: vLLM on port \${port} exited before it answered" >&2
      dump_probe_log "\${port}"
      return 1
    fi
    # vLLM says nothing about the download size, so add what it cannot: how long
    # this has taken, how much has landed on disk, and what the GPU holds.
    waited=$(( SECONDS - spoke ))
    if (( spoke == 0 || waited >= 60 )); then
      spoke=\${SECONDS}
      echo "[redrob] port=\${port} waiting \${SECONDS}s  cache=$(du -sh "\${HF_HOME}" 2>/dev/null | cut -f1)  gpu=$(gpu_used)MiB"
    fi
    sleep 5
  done
  stop_follow
  echo "ERROR: readiness timeout on 127.0.0.1:\${port} after \${READY_TIMEOUT_SEC}s" >&2
  dump_probe_log "\${port}"
  return 1
}
# start_probe port model served util dtype max_len max_seqs [quant]
start_probe() {
  local port="$1" model="$2" served="$3" util="$4" dtype="$5" max_len="$6" max_seqs="$7" quant="\${8:-none}"
  local log="\${PROBE_LOG_DIR}/probe-\${port}.log"; kill_probe "\${port}"; : > "\${log}"
  local -a cmd=( "\${VLLM_BIN}" serve "\${model}" --host 127.0.0.1 --port "\${port}"
    --api-key "\${VLLM_API_KEY}" --served-model-name "\${served}" --dtype "\${dtype}"
    --gpu-memory-utilization "\${util}" --max-model-len "\${max_len}" --max-num-seqs "\${max_seqs}" )
  [[ "\${quant}" != "none" && -n "\${quant}" ]] && cmd+=(--quantization "\${quant}")
  if [[ "$(id -u)" -eq 0 ]]; then
    install -d -o redrob-vllm -g redrob-vllm -m 700 "\${SERVICE_HOME}/.cache" 2>/dev/null
    sudo -u redrob-vllm -E env HOME="\${SERVICE_HOME}" XDG_CACHE_HOME="\${SERVICE_HOME}/.cache" \\
      PATH="\${PROBE_PATH}" "\${cmd[@]}" >>"\${log}" 2>&1 &
  else PATH="\${PROBE_PATH}" "\${cmd[@]}" >>"\${log}" 2>&1 & fi
  echo $! > "\${PROBE_LOG_DIR}/pid-\${port}"
  echo "    started probe port=\${port} util=\${util} dtype=\${dtype} quant=\${quant}"
  start_follow "\${port}"
}
short_completion() {
  local port="$1" model="$2"
  curl -sf -H "Authorization: Bearer \${VLLM_API_KEY}" -H "Content-Type: application/json" \\
    "http://127.0.0.1:\${port}/v1/chat/completions" \\
    -d "{\\"model\\":\\"\${model}\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"Reply with OK\\"}],\\"max_tokens\\":8,\\"temperature\\":0}" \\
    | grep -q '"content"'
}
weight_mib_from_gib() { [[ -z "$1" ]] && { echo ""; return 0; }; python3 -c "print(int(float('$1')*1024))"; }
# What this model actually needs to serve, read back from the probe's own log.
#
# vLLM turns --gpu-memory-utilization into a static KV pool, so a 2B model
# measured on a free card reserved 41 GiB of KV for 3.2M tokens when the
# workload only ever needs max_model_len x max_num_seqs. Two slots then filled
# a 96 GiB card and the third could not load. Sizing the pool from the measured
# cost per token, and the util from the footprint that implies, is what lets
# slots keep fitting while there is memory. Prints "KV_BYTES UTIL", or NONE
# when the log did not carry the numbers.
size_serve_from_probe() {
  local log="$1"
  python3 - "\${log}" "\${MAX_LEN}" "\${MAX_SEQS}" "\${TOTAL_MIB}" <<'PY'
import re, sys

log, max_len, max_seqs, total_mib = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), float(sys.argv[4])
try:
    text = open(log, errors='replace').read()
except OSError:
    print('NONE'); raise SystemExit
avail = re.findall(r'Available KV cache memory:\\s*([0-9.]+)\\s*GiB', text)
tokens = re.findall(r'GPU KV cache size:\\s*([0-9,]+)\\s*tokens', text)
usage = re.findall(
    r'Actual usage is ([0-9.]+) GiB for weight, ([0-9.]+) GiB for peak activation, '
    r'([0-9.]+) GiB for non-torch memory, and ([0-9.]+) GiB for CUDAGraph memory',
    text,
)
if not (avail and tokens and usage and total_mib > 0):
    print('NONE'); raise SystemExit
kv_gib, kv_tokens = float(avail[-1]), int(tokens[-1].replace(',', ''))
if kv_gib <= 0 or kv_tokens <= 0:
    print('NONE'); raise SystemExit

per_token = kv_gib / kv_tokens
# Every slot can hold max_num_seqs requests of max_model_len at once. The x2
# floor keeps a single-sequence config from getting a pool it cannot schedule
# around; the margin absorbs block rounding.
need_tokens = max(max_len * max_seqs, max_len * 2)
kv = per_token * need_tokens * 1.25
weight, activation, non_torch, cudagraph = (float(x) for x in usage[-1])
# One GiB of slack: fragmentation and allocator overhead are not in the report.
serve_gib = weight + activation + non_torch + cudagraph + kv + 1.0
util = max(0.05, min(0.90, serve_gib / (total_mib / 1024.0)))
print(f'{int(kv * (1024 ** 3))} {util:.4f}')
PY
}
# Which reasoning parser this model needs, or "none".
#
# Models like LFM2.5 have a chat template that opens <think> in the generation
# prompt, so the trace arrives as ordinary content and every answer is prefixed
# with the model's inner monologue. vLLM can split it off, but only when both
# think tokens are single tokens in the vocab - it refuses to start otherwise,
# which is why this is detected per model rather than always passed.
detect_reasoning_parser() {
  local model="$1"
  "\${VENV_BIN}/python" - "\${model}" <<'PY' 2>/dev/null || echo "none"
import sys
try:
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(sys.argv[1])
    vocab = tok.get_vocab()
    if vocab.get("<think>") is not None and vocab.get("</think>") is not None:
        print("deepseek_r1")
    else:
        print("none")
except Exception:
    print("none")
PY
}

echo "==> measure starting  slot=\${SLOT}  \${MODEL} as \${SERVED} on port \${PORT}  max_model_len=\${MAX_LEN} max_num_seqs=\${MAX_SEQS}"
stop_this_slot
TOTAL_MIB="$(gpu_total)"; GPU_NAME="$(gpu_name)"; FREE_BEFORE="$(gpu_free)"
[[ "\${TOTAL_MIB}" =~ ^[0-9]+$ ]] || { echo "ERROR: cannot read GPU memory.total" >&2; exit 1; }
[[ "\${FREE_BEFORE}" =~ ^[0-9]+$ ]] || { echo "ERROR: cannot read GPU memory.free" >&2; exit 1; }
echo "    GPU=\${GPU_NAME}  TOTAL_MIB=\${TOTAL_MIB}  FREE_MIB=\${FREE_BEFORE} (other slots may still hold VRAM)"

DTYPE="bfloat16"
QUANT="none"
# vLLM util is a fraction of TOTAL card memory, reserved as a static pool for
# the life of the process. Size it from free VRAM so a slot brought up after
# another fits what is left - that is the real "as memory allows" limit. Soft-
# cap a single claim at half the card so the first slot measured on an empty
# GPU cannot swallow it and make Add slot useless; later slots see reduced
# free and take from the remainder. Dividing by MAX_SLOTS instead would shrink
# every claim as the ceiling rose, and a 1.7B model would fail to come up on
# an otherwise empty card.
#
# Read at each attempt, never once up front: measuring one slot while another is
# restarting saw 84 GiB free, asked for half the card, and by the time the probe
# claimed memory the other slot was back and vLLM refused with "Free memory on
# device is less than desired GPU memory utilization".
compute_util() {
  local free; free="$(gpu_free)"
  [[ "\${free}" =~ ^[0-9]+$ ]] || { echo ""; return 1; }
  python3 -c "
free=float(\${free}); total=float(\${TOTAL_MIB}); hr=float(\${HEADROOM_FRAC})
if total <= 0: raise SystemExit('bad total')
from_free = (free / total) * (1.0 - hr)
single_share = 0.50
frac = min(from_free, single_share)
# Floor so a tiny free fraction fails loudly instead of probing with util≈0;
# hard cap keeps a nearly empty card from claiming more than headroom allows.
frac = max(0.05, min(0.90, frac))
print(f'{frac:.4f}')
"
}
# vLLM's own words when another process took the memory between our reading and
# its allocation. Worth another look at free VRAM rather than blaming the model.
util_race() {
  grep -q 'is less than desired GPU memory utilization' \\
    "\${PROBE_LOG_DIR}/probe-\${PORT}.log" 2>/dev/null
}

load() {
  GPU_MEM_UTIL="$(compute_util)"
  [[ -n "\${GPU_MEM_UTIL}" ]] || { echo "ERROR: could not compute util" >&2; return 1; }
  echo "==> Load \${MODEL} at util=\${GPU_MEM_UTIL} (free now $(gpu_free) MiB) dtype=\${DTYPE} quant=\${QUANT} max_model_len=\${MAX_LEN}"
  start_probe "\${PORT}" "\${MODEL}" "\${SERVED}" "\${GPU_MEM_UTIL}" "\${DTYPE}" "\${MAX_LEN}" "\${MAX_SEQS}" "\${QUANT}"
  wait_ready "\${PORT}"
}

LOADED=0
for attempt in 1 2 3; do
  if load; then LOADED=1; break; fi
  kill_probe "\${PORT}"
  # Losing the memory race is not a fact about the model, so do not spend the
  # FP8 retry on it: re-read free VRAM and ask for what is actually there.
  if util_race && (( attempt < 3 )); then
    echo "==> another slot claimed the card mid-load - retrying against free VRAM as it is now"
    sleep 5
    continue
  fi
  # Almost always the weights not fitting, and FP8 halves them. One retry only:
  # if that fails too, the model does not belong in the remaining free VRAM.
  if [[ "\${QUANT}" == "none" ]]; then
    echo "==> bfloat16 did not come up - one retry with FP8"
    QUANT="fp8"
    continue
  fi
  break
done
(( LOADED == 1 )) || { echo "ERROR: \${MODEL} did not come up in bfloat16 or FP8" >&2; exit 1; }

USED_MIB="$(gpu_used)"
WEIGHT_MIB="$(weight_mib_from_gib "$(scrape_weight_gib "\${PROBE_LOG_DIR}/probe-\${PORT}.log")")"
short_completion "\${PORT}" "\${SERVED}" || { echo "ERROR: \${MODEL} loaded but did not answer" >&2; exit 1; }
FREE_MIB="$(gpu_free)"
echo "    USED_MIB=\${USED_MIB}  WEIGHT_MIB=\${WEIGHT_MIB:-unknown}  FREE_MIB=\${FREE_MIB}"

# The probe deliberately loads big to find out what the model costs. What gets
# served is sized down to that answer, so the next slot still has a card to
# load into.
PROBE_GPU_MEM_UTIL="\${GPU_MEM_UTIL}"
KV_CACHE_MEMORY=""
SIZED="$(size_serve_from_probe "\${PROBE_LOG_DIR}/probe-\${PORT}.log")"
if [[ -n "\${SIZED}" && "\${SIZED}" != "NONE" ]]; then
  KV_CACHE_MEMORY="\${SIZED%% *}"
  GPU_MEM_UTIL="\${SIZED##* }"
  echo "    sized for serving: kv_cache_memory=\${KV_CACHE_MEMORY} bytes  util=\${GPU_MEM_UTIL} (probe ran at \${PROBE_GPU_MEM_UTIL})"
else
  echo "    WARN: probe log carried no KV sizing; serving at the probe util \${GPU_MEM_UTIL}"
fi
kill_probe "\${PORT}"; sleep 3

REASONING_PARSER="$(detect_reasoning_parser "\${MODEL}")"
echo "    reasoning_parser=\${REASONING_PARSER}"

MEASURED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
umask 077
# The slot directory has to stay traversable: the status check reads it as the
# login user, and a 0700 directory made Serve look blocked on a measurement
# that had already been written. Only slot 0 escaped it, because Install had
# already created that directory.
mkdir -p "$(dirname "\${MEASURED_ENV}")"
chmod 0755 "$(dirname "\${MEASURED_ENV}")"
# Written whole rather than patched. Values belong to this slot's model; a
# leftover from the one before would be a util measured on different weights.
{
  echo "# Generated by UI Measure (SSH) slot \${SLOT} - do not hand-edit util/MiB guesses"
  echo "MODEL_HF=\${MODEL}"
  echo "SERVED_MODEL_NAME=\${SERVED}"
  echo "DTYPE=\${DTYPE}"
  echo "QUANTIZATION=\${QUANT}"
  echo "REASONING_PARSER=\${REASONING_PARSER}"
  echo "GPU_MEM_UTIL=\${GPU_MEM_UTIL}"
  echo "KV_CACHE_MEMORY=\${KV_CACHE_MEMORY}"
  echo "PROBE_GPU_MEM_UTIL=\${PROBE_GPU_MEM_UTIL}"
  echo "MAX_MODEL_LEN=\${MAX_LEN}"
  echo "MAX_NUM_SEQS=\${MAX_SEQS}"
  echo "WEIGHT_MIB=\${WEIGHT_MIB}"
  echo "USED_MIB=\${USED_MIB}"
  echo "MEASURED_AT=\${MEASURED_AT}"
  echo "GPU_NAME=\${GPU_NAME}"
  echo "GPU_TOTAL_MIB=\${TOTAL_MIB}"
  echo "FREE_MIB=\${FREE_MIB}"
  echo "MEASURE_HEADROOM_FRAC=\${HEADROOM_FRAC}"
  echo "SLOT=\${SLOT}"
} > "\${MEASURED_ENV}"
chgrp redrob-vllm "\${MEASURED_ENV}" 2>/dev/null || true
# Sizes and dimensions, no secrets: those live in secrets.env. The status check
# reads this file as the login user, and at 0640 it silently read nothing, so
# the UI kept Serve blocked on a measurement that had already happened.
chmod 0644 "\${MEASURED_ENV}"
systemctl daemon-reload || true

# Machine-parseable result block for the server
echo "RESULT_MEASURED_AT=\${MEASURED_AT}"
echo "RESULT_GPU_NAME=\${GPU_NAME}"
echo "RESULT_GPU_TOTAL_MIB=\${TOTAL_MIB}"
echo "RESULT_MODEL_HF=\${MODEL}"
echo "RESULT_SERVED_MODEL_NAME=\${SERVED}"
echo "RESULT_GPU_MEM_UTIL=\${GPU_MEM_UTIL}"
echo "RESULT_KV_CACHE_MEMORY=\${KV_CACHE_MEMORY}"
echo "RESULT_DTYPE=\${DTYPE}"
echo "RESULT_QUANTIZATION=\${QUANT}"
echo "RESULT_REASONING_PARSER=\${REASONING_PARSER}"
echo "RESULT_MAX_MODEL_LEN=\${MAX_LEN}"
echo "RESULT_MAX_NUM_SEQS=\${MAX_SEQS}"
echo "RESULT_WEIGHT_MIB=\${WEIGHT_MIB}"
echo "RESULT_USED_MIB=\${USED_MIB}"
echo "RESULT_FREE_MIB=\${FREE_MIB}"
echo "RESULT_SLOT=\${SLOT}"
echo "MEASURE_OK"
`;
}
