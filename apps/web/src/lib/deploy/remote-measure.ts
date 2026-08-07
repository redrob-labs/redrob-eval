import { PORTS } from './remote';

/**
 * Self-contained remote measurement (root) behind the Measure step on /deploy.
 *
 * Runs entirely on the GPU host: stops units, measures solo L then S VRAM from
 * real nvidia-smi / vLLM logs, computes GPU_MEM_UTIL_* leaving headroom, retries
 * L in FP8 when weights exceed the trigger, verifies dual load, and writes
 * /etc/redrob-vllm/measured.env. Prints RESULT_* lines for the server to parse.
 *
 * Never invents util/MiB. If a weight cannot be measured, it exits non-zero.
 * Requires secret env: VLLM_API_KEY, HF_TOKEN (passed via SSH secretEnv).
 */
export interface MeasureParams {
  modelS: string;
  modelL: string;
  servedS: string;
  servedL: string;
  maxModelLen: number;
  maxNumSeqs: number;
  provisionalUtil?: number;
  headroomFrac?: number;
  fp8TriggerFrac?: number;
  readyTimeoutSec?: number;
}

export function measureScript(p: MeasureParams): string {
  const provisional = p.provisionalUtil ?? 0.9;
  const headroom = p.headroomFrac ?? 0.12;
  const fp8Trigger = p.fp8TriggerFrac ?? 0.75;
  const readyTimeout = p.readyTimeoutSec ?? 900;

  return `set -uo pipefail
export HF_TOKEN="\${HF_TOKEN:-}"
export HUGGING_FACE_HUB_TOKEN="\${HF_TOKEN:-}"
export HF_HOME="/opt/redrob-vllm/hf-cache"

PROBE_LOG_DIR="/tmp/redrob-vllm-measure"
VLLM_BIN="/opt/redrob-vllm/venv/bin/vllm"
READY_TIMEOUT_SEC=${readyTimeout}
PROVISIONAL_UTIL=${provisional}
HEADROOM_FRAC=${headroom}
FP8_TRIGGER=${fp8Trigger}
MAX_LEN=${p.maxModelLen}
MAX_SEQS=${p.maxNumSeqs}
MODEL_S='${p.modelS}'
MODEL_L='${p.modelL}'
SERVED_S='${p.servedS}'
SERVED_L='${p.servedL}'
mkdir -p "\${PROBE_LOG_DIR}"

gpu_total() { nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -n1 | tr -d ' '; }
gpu_used()  { nvidia-smi --query-gpu=memory.used  --format=csv,noheader,nounits | head -n1 | tr -d ' '; }
gpu_free()  { nvidia-smi --query-gpu=memory.free  --format=csv,noheader,nounits | head -n1 | tr -d ' '; }
gpu_name()  { nvidia-smi --query-gpu=name --format=csv,noheader | head -n1; }

kill_probe() {
  local port="$1"
  if [[ -f "\${PROBE_LOG_DIR}/pid-\${port}" ]]; then
    local pid; pid="$(cat "\${PROBE_LOG_DIR}/pid-\${port}")"
    kill "\${pid}" 2>/dev/null || true
    wait "\${pid}" 2>/dev/null || true
    rm -f "\${PROBE_LOG_DIR}/pid-\${port}"
  fi
  command -v fuser >/dev/null 2>&1 && fuser -k "\${port}/tcp" 2>/dev/null || true
  sleep 2
}
stop_units() {
  systemctl stop redrob-vllm-s.service redrob-vllm-l.service 2>/dev/null || true
  kill_probe ${PORTS.s}; kill_probe ${PORTS.l}; sleep 2
}
scrape_weight_gib() {
  local log="$1"; local line
  line="$(grep -Eo 'Model loading took [0-9.]+ (GiB|GB)' "\${log}" 2>/dev/null | tail -n1 || true)"
  [[ -z "\${line}" ]] && { echo ""; return 0; }
  echo "\${line}" | grep -Eo '[0-9.]+' | head -n1
}
wait_ready() {
  local port="$1"; local deadline=$(( SECONDS + READY_TIMEOUT_SEC ))
  while (( SECONDS < deadline )); do
    curl -sf -H "Authorization: Bearer \${VLLM_API_KEY}" "http://127.0.0.1:\${port}/v1/models" >/dev/null 2>&1 && return 0
    sleep 5
  done
  echo "ERROR: readiness timeout on 127.0.0.1:\${port}" >&2; return 1
}
# start_axis port model served util dtype max_len max_seqs [quant]
start_axis() {
  local port="$1" model="$2" served="$3" util="$4" dtype="$5" max_len="$6" max_seqs="$7" quant="\${8:-none}"
  local log="\${PROBE_LOG_DIR}/axis-\${port}.log"; kill_probe "\${port}"; : > "\${log}"
  local -a cmd=( "\${VLLM_BIN}" serve "\${model}" --host 127.0.0.1 --port "\${port}"
    --api-key "\${VLLM_API_KEY}" --served-model-name "\${served}" --dtype "\${dtype}"
    --gpu-memory-utilization "\${util}" --max-model-len "\${max_len}" --max-num-seqs "\${max_seqs}" )
  [[ "\${quant}" != "none" && -n "\${quant}" ]] && cmd+=(--quantization "\${quant}")
  if [[ "$(id -u)" -eq 0 ]]; then sudo -u redrob-vllm -E "\${cmd[@]}" >>"\${log}" 2>&1 &
  else "\${cmd[@]}" >>"\${log}" 2>&1 & fi
  echo $! > "\${PROBE_LOG_DIR}/pid-\${port}"
  echo "    started probe port=\${port} util=\${util} dtype=\${dtype} quant=\${quant}"
}
short_completion() {
  local port="$1" model="$2"
  curl -sf -H "Authorization: Bearer \${VLLM_API_KEY}" -H "Content-Type: application/json" \\
    "http://127.0.0.1:\${port}/v1/chat/completions" \\
    -d "{\\"model\\":\\"\${model}\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"Reply with OK\\"}],\\"max_tokens\\":8,\\"temperature\\":0}" \\
    | grep -q '"content"'
}
weight_mib_from_gib() { [[ -z "$1" ]] && { echo ""; return 0; }; python3 -c "print(int(float('$1')*1024))"; }

measure_solo() { # label port model served dtype quant -> USED_MIB / WEIGHT_GIB
  local label="$1" port="$2" model="$3" served="$4" dtype="$5" quant="$6"
  echo "==> Solo \${label}: util=\${PROVISIONAL_UTIL} dtype=\${dtype} quant=\${quant} max_model_len=\${MAX_LEN}"
  start_axis "\${port}" "\${model}" "\${served}" "\${PROVISIONAL_UTIL}" "\${dtype}" "\${MAX_LEN}" "\${MAX_SEQS}" "\${quant}"
  wait_ready "\${port}" || return 1
  echo "USED_MIB=$(gpu_used)"
  echo "WEIGHT_GIB=$(scrape_weight_gib "\${PROBE_LOG_DIR}/axis-\${port}.log")"
  kill_probe "\${port}"; sleep 3
}
weight_probe() { # port model served dtype quant -> WEIGHT_MIB on stdout
  local port="$1" model="$2" served="$3" dtype="$4" quant="$5" util="0.10" gib used
  while python3 -c "import sys; sys.exit(0 if float('\${util}')<=0.95 else 1)"; do
    echo "    weight-probe \${served} util=\${util}" >&2
    start_axis "\${port}" "\${model}" "\${served}" "\${util}" "\${dtype}" "1024" "1" "\${quant}"
    if wait_ready "\${port}"; then
      used="$(gpu_used)"; gib="$(scrape_weight_gib "\${PROBE_LOG_DIR}/axis-\${port}.log")"
      kill_probe "\${port}"; sleep 2
      if [[ -n "\${gib}" ]]; then weight_mib_from_gib "\${gib}"; return 0; fi
      [[ -n "\${used}" ]] && { echo "\${used}"; return 0; }
    fi
    kill_probe "\${port}"; sleep 2
    util="$(python3 -c "print(round(float('\${util}')+0.05,2))")"
  done
  return 1
}

echo "==> measure starting  L=\${MODEL_L}  S=\${MODEL_S}  max_model_len=\${MAX_LEN} max_num_seqs=\${MAX_SEQS}"
stop_units
TOTAL_MIB="$(gpu_total)"; GPU_NAME="$(gpu_name)"
[[ "\${TOTAL_MIB}" =~ ^[0-9]+$ ]] || { echo "ERROR: cannot read GPU memory.total" >&2; exit 1; }
echo "    GPU=\${GPU_NAME}  TOTAL_MIB=\${TOTAL_MIB}"

# --- L bf16 ---
L_DTYPE="bfloat16"; L_QUANT="none"
L_SOLO="$(measure_solo L ${PORTS.l} "\${MODEL_L}" "\${SERVED_L}" "\${L_DTYPE}" "\${L_QUANT}")" || { echo "ERROR: L solo failed" >&2; exit 1; }
echo "\${L_SOLO}"
L_USED="$(echo "\${L_SOLO}" | grep '^USED_MIB=' | tail -n1 | cut -d= -f2- | tr -d '\\r')"
L_WGIB="$(echo "\${L_SOLO}" | grep '^WEIGHT_GIB=' | tail -n1 | cut -d= -f2- | tr -d '\\r')"
L_WEIGHT_MIB="$(weight_mib_from_gib "\${L_WGIB}")"
if [[ -z "\${L_WEIGHT_MIB}" ]]; then
  echo "==> L weight not in log - weight probe"
  L_WEIGHT_MIB="$(weight_probe ${PORTS.l} "\${MODEL_L}" "\${SERVED_L}" "\${L_DTYPE}" "\${L_QUANT}")" || { echo "ERROR: L weight probe failed (refusing to invent util)" >&2; exit 1; }
fi
L_FRAC="$(python3 -c "print(\${L_WEIGHT_MIB}/float(\${TOTAL_MIB}))")"
echo "    L_WEIGHT_MIB=\${L_WEIGHT_MIB}  L_FRAC=\${L_FRAC}"
if python3 -c "import sys; sys.exit(0 if float('\${L_FRAC}')>float('\${FP8_TRIGGER}') else 1)"; then
  echo "==> L weight fraction > \${FP8_TRIGGER} - retry L with FP8"
  L_QUANT="fp8"
  L_SOLO="$(measure_solo L ${PORTS.l} "\${MODEL_L}" "\${SERVED_L}" "\${L_DTYPE}" "\${L_QUANT}")" || { echo "ERROR: L fp8 solo failed" >&2; exit 1; }
  echo "\${L_SOLO}"
  L_USED="$(echo "\${L_SOLO}" | grep '^USED_MIB=' | tail -n1 | cut -d= -f2- | tr -d '\\r')"
  L_WGIB="$(echo "\${L_SOLO}" | grep '^WEIGHT_GIB=' | tail -n1 | cut -d= -f2- | tr -d '\\r')"
  L_WEIGHT_MIB="$(weight_mib_from_gib "\${L_WGIB}")"
  [[ -z "\${L_WEIGHT_MIB}" ]] && L_WEIGHT_MIB="$(weight_probe ${PORTS.l} "\${MODEL_L}" "\${SERVED_L}" "\${L_DTYPE}" "\${L_QUANT}")"
  [[ -z "\${L_WEIGHT_MIB}" ]] && { echo "ERROR: fp8 L weight measure failed" >&2; exit 1; }
  L_FRAC="$(python3 -c "print(\${L_WEIGHT_MIB}/float(\${TOTAL_MIB}))")"
  echo "    L_WEIGHT_MIB(fp8)=\${L_WEIGHT_MIB}  L_FRAC=\${L_FRAC}"
fi

# --- S bf16 ---
S_DTYPE="bfloat16"; S_QUANT="none"
S_SOLO="$(measure_solo S ${PORTS.s} "\${MODEL_S}" "\${SERVED_S}" "\${S_DTYPE}" "\${S_QUANT}")" || { echo "ERROR: S solo failed" >&2; exit 1; }
echo "\${S_SOLO}"
S_USED="$(echo "\${S_SOLO}" | grep '^USED_MIB=' | tail -n1 | cut -d= -f2- | tr -d '\\r')"
S_WGIB="$(echo "\${S_SOLO}" | grep '^WEIGHT_GIB=' | tail -n1 | cut -d= -f2- | tr -d '\\r')"
S_WEIGHT_MIB="$(weight_mib_from_gib "\${S_WGIB}")"
if [[ -z "\${S_WEIGHT_MIB}" ]]; then
  echo "==> S weight not in log - weight probe"
  S_WEIGHT_MIB="$(weight_probe ${PORTS.s} "\${MODEL_S}" "\${SERVED_S}" "\${S_DTYPE}" "\${S_QUANT}")" || { echo "ERROR: S weight probe failed" >&2; exit 1; }
fi
S_FRAC="$(python3 -c "print(\${S_WEIGHT_MIB}/float(\${TOTAL_MIB}))")"
echo "    S_WEIGHT_MIB=\${S_WEIGHT_MIB}  S_FRAC=\${S_FRAC}"

# --- compute utils leaving headroom ---
COMPUTED="$(python3 - <<PY
total=float(\${TOTAL_MIB}); w_l=float(\${L_WEIGHT_MIB}); w_s=float(\${S_WEIGHT_MIB}); headroom=float(\${HEADROOM_FRAC})
avail=1.0-headroom; fl=w_l/total; fs=w_s/total
if fl+fs>=avail:
    print("TIGHT=1")
    util_l=min(fl+0.02, avail*0.7); util_s=min(fs+0.02, avail-util_l)
    if util_s<fs: util_s=fs; util_l=avail-util_s
else:
    print("TIGHT=0"); rem=avail-fl-fs
    util_l=fl+rem*(fl/(fl+fs)); util_s=fs+rem*(fs/(fl+fs))
print(f"GPU_MEM_UTIL_L={util_l:.4f}"); print(f"GPU_MEM_UTIL_S={util_s:.4f}")
PY
)"
echo "\${COMPUTED}"
GPU_MEM_UTIL_L="$(echo "\${COMPUTED}" | grep '^GPU_MEM_UTIL_L=' | cut -d= -f2-)"
GPU_MEM_UTIL_S="$(echo "\${COMPUTED}" | grep '^GPU_MEM_UTIL_S=' | cut -d= -f2-)"
TIGHT="$(echo "\${COMPUTED}" | grep '^TIGHT=' | cut -d= -f2-)"
[[ -z "\${GPU_MEM_UTIL_L}" || -z "\${GPU_MEM_UTIL_S}" ]] && { echo "ERROR: could not compute utils" >&2; exit 1; }
MAX_LEN_L="\${MAX_LEN}"; MAX_LEN_S="\${MAX_LEN}"
if [[ "\${TIGHT}" == "1" ]]; then echo "==> tight; lowering max_model_len to 4096 for KV"; MAX_LEN_L=4096; MAX_LEN_S=4096; fi

# --- dual verify ---
echo "==> Dual start L_util=\${GPU_MEM_UTIL_L} S_util=\${GPU_MEM_UTIL_S}"
stop_units
start_axis ${PORTS.l} "\${MODEL_L}" "\${SERVED_L}" "\${GPU_MEM_UTIL_L}" "\${L_DTYPE}" "\${MAX_LEN_L}" "\${MAX_SEQS}" "\${L_QUANT}"
wait_ready ${PORTS.l} || { echo "ERROR: dual L not ready" >&2; exit 1; }
start_axis ${PORTS.s} "\${MODEL_S}" "\${SERVED_S}" "\${GPU_MEM_UTIL_S}" "\${S_DTYPE}" "\${MAX_LEN_S}" "\${MAX_SEQS}" "\${S_QUANT}"
wait_ready ${PORTS.s} || { echo "ERROR: dual S not ready" >&2; exit 1; }
DUAL_FREE="$(gpu_free)"; DUAL_USED="$(gpu_used)"
echo "    DUAL_FREE_MIB=\${DUAL_FREE}  DUAL_USED_MIB=\${DUAL_USED}"
[[ "\${DUAL_FREE}" -gt 0 ]] || { echo "ERROR: no free VRAM after dual load" >&2; exit 1; }
short_completion ${PORTS.l} "\${SERVED_L}" || { echo "ERROR: L completion failed" >&2; exit 1; }
short_completion ${PORTS.s} "\${SERVED_S}" || { echo "ERROR: S completion failed" >&2; exit 1; }
kill_probe ${PORTS.s}; kill_probe ${PORTS.l}; sleep 3

MEASURED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
umask 077
mkdir -p /etc/redrob-vllm
cat > /etc/redrob-vllm/measured.env <<EOF
# Generated by UI Measure (SSH) - do not hand-edit util/MiB guesses
MODEL_HF_S=\${MODEL_S}
MODEL_HF_L=\${MODEL_L}
SERVED_MODEL_NAME_S=\${SERVED_S}
SERVED_MODEL_NAME_L=\${SERVED_L}
DTYPE_S=\${S_DTYPE}
DTYPE_L=\${L_DTYPE}
QUANTIZATION_L=\${L_QUANT}
GPU_MEM_UTIL_S=\${GPU_MEM_UTIL_S}
GPU_MEM_UTIL_L=\${GPU_MEM_UTIL_L}
MAX_MODEL_LEN_S=\${MAX_LEN_S}
MAX_MODEL_LEN_L=\${MAX_LEN_L}
MAX_NUM_SEQS_S=\${MAX_SEQS}
MAX_NUM_SEQS_L=\${MAX_SEQS}
MEASURED_AT=\${MEASURED_AT}
GPU_NAME=\${GPU_NAME}
GPU_TOTAL_MIB=\${TOTAL_MIB}
L_WEIGHT_MIB=\${L_WEIGHT_MIB}
S_WEIGHT_MIB=\${S_WEIGHT_MIB}
L_SOLO_USED_MIB=\${L_USED}
S_SOLO_USED_MIB=\${S_USED}
DUAL_FREE_MIB=\${DUAL_FREE}
MEASURE_HEADROOM_FRAC=\${HEADROOM_FRAC}
EOF
chgrp redrob-vllm /etc/redrob-vllm/measured.env 2>/dev/null || true
chmod 0640 /etc/redrob-vllm/measured.env
systemctl daemon-reload || true

# Machine-parseable result block for the server
echo "RESULT_MEASURED_AT=\${MEASURED_AT}"
echo "RESULT_GPU_NAME=\${GPU_NAME}"
echo "RESULT_GPU_TOTAL_MIB=\${TOTAL_MIB}"
echo "RESULT_GPU_MEM_UTIL_L=\${GPU_MEM_UTIL_L}"
echo "RESULT_GPU_MEM_UTIL_S=\${GPU_MEM_UTIL_S}"
echo "RESULT_DTYPE_L=\${L_DTYPE}"
echo "RESULT_QUANTIZATION_L=\${L_QUANT}"
echo "RESULT_DTYPE_S=\${S_DTYPE}"
echo "RESULT_MAX_MODEL_LEN_L=\${MAX_LEN_L}"
echo "RESULT_MAX_MODEL_LEN_S=\${MAX_LEN_S}"
echo "RESULT_MAX_NUM_SEQS=\${MAX_SEQS}"
echo "RESULT_L_WEIGHT_MIB=\${L_WEIGHT_MIB}"
echo "RESULT_S_WEIGHT_MIB=\${S_WEIGHT_MIB}"
echo "RESULT_L_SOLO_USED_MIB=\${L_USED}"
echo "RESULT_S_SOLO_USED_MIB=\${S_USED}"
echo "RESULT_DUAL_FREE_MIB=\${DUAL_FREE}"
echo "MEASURE_OK"
`;
}
