/**
 * Remote bash builders for GPU-host operations.
 *
 * These strings are executed on the GPU host over SSH by operations.ts.
 * They replace the old deploy/*.sh orchestration — the same remote commands,
 * now driven from the web server / UI instead of a human running scripts.
 *
 * Invariants preserved from the original scripts:
 *  - vLLM binds 127.0.0.1 only (never 0.0.0.0)
 *  - --api-key always required
 *  - --served-model-name explicit (stable Eval id independent of HF path)
 *  - services refuse to start without /etc/redrob-vllm/measured.env
 *  - GPU_MEM_UTIL_* come only from measured nvidia-smi / vLLM logs (never invented)
 *  - --max-model-len bounded (8192 default), never native 256K
 *  - dedicated user redrob-vllm, dedicated ports, dedicated log paths
 */

export const PORTS = { s: 8101, l: 8102 } as const;

/** Marker file naming the op currently in flight, so the UI can show it. */
export const RUNNING_MARKER = '/tmp/redrob-op.running';

/** systemd unit content for one axis (loopback only, restart on failure). */
export function unitFile(axis: 'S' | 'L'): string {
  const lower = axis.toLowerCase();
  const port = axis === 'S' ? PORTS.s : PORTS.l;
  return `[Unit]
Description=Redrob vLLM axis ${axis} (loopback only)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=redrob-vllm
Group=redrob-vllm
WorkingDirectory=/opt/redrob-vllm

EnvironmentFile=-/etc/redrob-vllm/secrets.env
EnvironmentFile=/etc/redrob-vllm/measured.env

ExecStart=/opt/redrob-vllm/bin/serve-${lower}.sh

Restart=on-failure
RestartSec=5
TimeoutStartSec=0

StandardOutput=append:/var/log/redrob-vllm/${lower}.log
StandardError=append:/var/log/redrob-vllm/${lower}.log

NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
# port ${port}
`;
}

/** serve wrapper installed to /opt/redrob-vllm/bin/serve-{s,l}.sh */
export function serveWrapper(axis: 'S' | 'L'): string {
  const A = axis;
  const port = axis === 'S' ? PORTS.s : PORTS.l;
  return `#!/usr/bin/env bash
set -euo pipefail

: "\${VLLM_API_KEY:?VLLM_API_KEY required in secrets.env}"
: "\${MODEL_HF_${A}:?MODEL_HF_${A} required in measured.env}"
: "\${SERVED_MODEL_NAME_${A}:?SERVED_MODEL_NAME_${A} required in measured.env}"
: "\${GPU_MEM_UTIL_${A}:?GPU_MEM_UTIL_${A} required in measured.env}"
: "\${MAX_MODEL_LEN_${A}:?MAX_MODEL_LEN_${A} required in measured.env}"
: "\${MAX_NUM_SEQS_${A}:?MAX_NUM_SEQS_${A} required in measured.env}"
: "\${DTYPE_${A}:?DTYPE_${A} required in measured.env}"

EXTRA=()
if [[ -n "\${QUANTIZATION_${A}:-}" && "\${QUANTIZATION_${A}}" != "none" ]]; then
  EXTRA+=(--quantization "\${QUANTIZATION_${A}}")
fi

exec /opt/redrob-vllm/venv/bin/vllm serve "\${MODEL_HF_${A}}" \\
  --host 127.0.0.1 \\
  --port ${port} \\
  --api-key "\${VLLM_API_KEY}" \\
  --served-model-name "\${SERVED_MODEL_NAME_${A}}" \\
  --dtype "\${DTYPE_${A}}" \\
  --gpu-memory-utilization "\${GPU_MEM_UTIL_${A}}" \\
  --max-model-len "\${MAX_MODEL_LEN_${A}}" \\
  --max-num-seqs "\${MAX_NUM_SEQS_${A}}" \\
  "\${EXTRA[@]}"
`;
}

/**
 * Install/provision (root). Writes units + wrappers via base64 to avoid quoting
 * pitfalls, creates the dedicated user/dirs, installs vLLM venv if missing.
 * Does NOT start services (measured.env required first).
 */
export function installScript(): string {
  const enc = (s: string) => Buffer.from(s, 'utf8').toString('base64');
  return `set -euo pipefail
# tmux keeps deploy steps alive across a dropped connection
if ! command -v tmux >/dev/null 2>&1; then
  echo "Installing tmux (keeps steps running if you disconnect)..."
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y tmux \\
      || echo "WARN: tmux install failed - steps will not survive a disconnect"
  else
    echo "WARN: no apt-get - install tmux manually so steps survive a disconnect"
  fi
fi
id -u redrob-vllm >/dev/null 2>&1 || useradd --system --home /opt/redrob-vllm --shell /usr/sbin/nologin redrob-vllm
mkdir -p /opt/redrob-vllm/bin /opt/redrob-vllm/hf-cache /etc/redrob-vllm /var/log/redrob-vllm
chown -R redrob-vllm:redrob-vllm /opt/redrob-vllm /var/log/redrob-vllm
chmod 0755 /etc/redrob-vllm /var/log/redrob-vllm
install -o redrob-vllm -g redrob-vllm -m 0644 /dev/null /var/log/redrob-vllm/s.log
install -o redrob-vllm -g redrob-vllm -m 0644 /dev/null /var/log/redrob-vllm/l.log

# secrets.env from injected env (never echoed)
umask 077
cat > /tmp/redrob-secrets.env <<EOF
VLLM_API_KEY=\${VLLM_API_KEY}
HF_TOKEN=\${HF_TOKEN}
HUGGING_FACE_HUB_TOKEN=\${HF_TOKEN}
HF_HOME=/opt/redrob-vllm/hf-cache
EOF
install -o root -g redrob-vllm -m 0640 /tmp/redrob-secrets.env /etc/redrob-vllm/secrets.env
rm -f /tmp/redrob-secrets.env

echo '${enc(unitFile('S'))}' | base64 -d > /etc/systemd/system/redrob-vllm-s.service
echo '${enc(unitFile('L'))}' | base64 -d > /etc/systemd/system/redrob-vllm-l.service
echo '${enc(serveWrapper('S'))}' | base64 -d > /opt/redrob-vllm/bin/serve-s.sh
echo '${enc(serveWrapper('L'))}' | base64 -d > /opt/redrob-vllm/bin/serve-l.sh
chmod 0644 /etc/systemd/system/redrob-vllm-s.service /etc/systemd/system/redrob-vllm-l.service
chmod 0755 /opt/redrob-vllm/bin/serve-s.sh /opt/redrob-vllm/bin/serve-l.sh
chown root:redrob-vllm /opt/redrob-vllm/bin/serve-s.sh /opt/redrob-vllm/bin/serve-l.sh

if [[ ! -x /opt/redrob-vllm/venv/bin/vllm ]]; then
  echo "Installing vLLM into /opt/redrob-vllm/venv (first time)..."
  python3 -m venv /opt/redrob-vllm/venv
  /opt/redrob-vllm/venv/bin/pip install --upgrade pip wheel
  /opt/redrob-vllm/venv/bin/pip install vllm
  chown -R redrob-vllm:redrob-vllm /opt/redrob-vllm/venv
else
  echo "vLLM venv already present - leaving existing install untouched"
fi

systemctl daemon-reload
systemctl enable redrob-vllm-s.service redrob-vllm-l.service
if [[ ! -f /etc/redrob-vllm/measured.env ]]; then
  echo "NOTE: measured.env missing - services will refuse to start until Measure runs."
  systemctl stop redrob-vllm-s.service redrob-vllm-l.service 2>/dev/null || true
fi
echo "INSTALL_OK"
`;
}

/** systemctl start/stop (root). Restart is stop then start — no separate op. */
export function serviceControl(action: 'start' | 'stop'): string {
  if (action === 'stop') {
    return `set -euo pipefail
systemctl stop redrob-vllm-s.service redrob-vllm-l.service 2>/dev/null || true
echo "STOP_OK"
`;
  }
  return `set -euo pipefail
if [[ ! -f /etc/redrob-vllm/measured.env ]]; then
  echo "ERROR: /etc/redrob-vllm/measured.env missing - run Measure first" >&2
  exit 1
fi
systemctl daemon-reload
systemctl restart redrob-vllm-l.service
systemctl restart redrob-vllm-s.service
systemctl is-active redrob-vllm-l.service || true
systemctl is-active redrob-vllm-s.service || true
echo "START_OK"
`;
}

/** Service + GPU status (non-root ok). */
export function statusScript(): string {
  return `set +e
echo "S_ACTIVE=$(systemctl is-active redrob-vllm-s.service 2>/dev/null)"
echo "L_ACTIVE=$(systemctl is-active redrob-vllm-l.service 2>/dev/null)"
echo "S_ENABLED=$(systemctl is-enabled redrob-vllm-s.service 2>/dev/null)"
echo "L_ENABLED=$(systemctl is-enabled redrob-vllm-l.service 2>/dev/null)"
if command -v tmux >/dev/null 2>&1; then
  echo "TMUX_PRESENT=1"
  if tmux has-session -t redrob 2>/dev/null; then echo "TMUX_SESSION=1"; else echo "TMUX_SESSION=0"; fi
else
  echo "TMUX_PRESENT=0"
  echo "TMUX_SESSION=0"
fi
# A step already in flight (survives disconnects) - UI shows it instead of re-offering
if [[ -f ${RUNNING_MARKER} ]]; then echo "RUNNING_OP=$(cat ${RUNNING_MARKER} 2>/dev/null | head -n1)"; fi
if [[ -f /etc/redrob-vllm/measured.env ]]; then echo "MEASURED_PRESENT=1"; else echo "MEASURED_PRESENT=0"; fi
if command -v nvidia-smi >/dev/null 2>&1; then
  echo "GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -n1)"
  echo "GPU_TOTAL_MIB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -n1 | tr -d ' ')"
  echo "GPU_USED_MIB=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits | head -n1 | tr -d ' ')"
  echo "GPU_FREE_MIB=$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits | head -n1 | tr -d ' ')"
fi
# Echo measured allocation lines (util + precision + tok/s) if present — no secrets there
if [[ -f /etc/redrob-vllm/measured.env ]]; then
  grep -E '^(GPU_MEM_UTIL_|MAX_MODEL_LEN_|MAX_NUM_SEQS_|DTYPE_|QUANTIZATION_|MEASURED_|SERVED_MODEL_NAME_|MODEL_HF_|GPU_TOTAL_MIB|DUAL_FREE_MIB|L_WEIGHT_MIB|S_WEIGHT_MIB)' /etc/redrob-vllm/measured.env || true
fi
echo "STATUS_OK"
`;
}

/**
 * Readiness (long, cold-start-tolerant) + liveness (short completion) + warmup.
 * Runs against the live systemd services on 127.0.0.1.
 */
export function healthScript(servedS: string, servedL: string, readyTimeoutSec = 600): string {
  return `set +e
KEY="\${VLLM_API_KEY}"
ready() {
  local port="$1"; local deadline=$(( SECONDS + ${readyTimeoutSec} ))
  while (( SECONDS < deadline )); do
    if curl -sf -H "Authorization: Bearer \${KEY}" "http://127.0.0.1:\${port}/v1/models" >/dev/null 2>&1; then
      return 0
    fi
    sleep 5
  done
  return 1
}
complete() {
  local port="$1"; local model="$2"
  curl -sf -H "Authorization: Bearer \${KEY}" -H "Content-Type: application/json" \\
    "http://127.0.0.1:\${port}/v1/chat/completions" \\
    -d "{\\"model\\":\\"\${model}\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"Reply with OK\\"}],\\"max_tokens\\":8,\\"temperature\\":0}" \\
    | grep -q '"content"'
}
echo "==> readiness L (127.0.0.1:${PORTS.l})"
if ready ${PORTS.l}; then echo "L_READY=1"; else echo "L_READY=0"; fi
echo "==> readiness S (127.0.0.1:${PORTS.s})"
if ready ${PORTS.s}; then echo "S_READY=1"; else echo "S_READY=0"; fi
echo "==> warmup + liveness"
if complete ${PORTS.l} '${servedL}'; then echo "L_LIVE=1"; else echo "L_LIVE=0"; fi
if complete ${PORTS.s} '${servedS}'; then echo "S_LIVE=1"; else echo "S_LIVE=0"; fi
echo "HEALTH_OK"
`;
}

/**
 * Throughput benchmark for relative cost.
 * relativeCostWeight(m) = 100 * (tok_per_sec_L / tok_per_sec_m); large = 100.
 * Measures output tok/s per axis and persists the numbers into measured.env so
 * they survive restarts and reach Eval through the status poll (root needed for
 * that write).
 */
export function benchmarkScript(servedS: string, servedL: string, maxTokens = 256): string {
  return `set +e
KEY="\${VLLM_API_KEY}"
bench() {
  local port="$1"; local model="$2"
  python3 - "$port" "$model" "${maxTokens}" <<'PY'
import json, sys, time, urllib.request, os
port, model, maxtok = sys.argv[1], sys.argv[2], int(sys.argv[3])
key = os.environ["VLLM_API_KEY"]
body = json.dumps({
  "model": model,
  "messages": [{"role":"user","content":"Write a detailed paragraph about distributed systems."}],
  "max_tokens": maxtok, "temperature": 0,
}).encode()
req = urllib.request.Request(
  f"http://127.0.0.1:{port}/v1/chat/completions",
  data=body,
  headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
)
t0 = time.time()
with urllib.request.urlopen(req, timeout=300) as r:
  data = json.loads(r.read())
dt = time.time() - t0
usage = data.get("usage", {})
out = usage.get("completion_tokens")
if not out:
  txt = data["choices"][0]["message"]["content"]
  out = max(1, len(txt.split()))
print(f"TOKPS={out/dt:.3f}")
print(f"OUT_TOKENS={out}")
print(f"ELAPSED_S={dt:.3f}")
PY
}
echo "==> benchmark L"
L_OUT=$(bench ${PORTS.l} '${servedL}')
echo "$L_OUT" | sed 's/^/L_/'
echo "==> benchmark S"
S_OUT=$(bench ${PORTS.s} '${servedS}')
echo "$S_OUT" | sed 's/^/S_/'

L_TOKPS="$(echo "$L_OUT" | grep '^TOKPS=' | cut -d= -f2-)"
S_TOKPS="$(echo "$S_OUT" | grep '^TOKPS=' | cut -d= -f2-)"
if [[ -n "\${L_TOKPS}" && -n "\${S_TOKPS}" && -f /etc/redrob-vllm/measured.env ]]; then
  sed -i '/^MEASURED_TOK_PER_SEC_[SL]=/d' /etc/redrob-vllm/measured.env
  printf 'MEASURED_TOK_PER_SEC_S=%s\\nMEASURED_TOK_PER_SEC_L=%s\\n' "\${S_TOKPS}" "\${L_TOKPS}" \\
    >> /etc/redrob-vllm/measured.env
  echo "measured.env updated with tok/s"
else
  echo "WARN: tok/s not recorded (missing measured.env or benchmark failed)" >&2
fi
echo "BENCH_OK"
`;
}
