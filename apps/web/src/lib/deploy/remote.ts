/**
 * Remote bash builders for GPU-host operations.
 *
 * These strings are executed on the GPU host over SSH by operations.ts.
 * They replace the old deploy/*.sh orchestration — the same remote commands,
 * now driven from the web server / UI instead of a human running scripts.
 *
 * Invariants preserved from the original scripts:
 *  - --api-key always required, and it is the only thing guarding the port
 *  - --served-model-name explicit (stable Eval id independent of HF path)
 *  - services refuse to start without that slot's measured.env
 *  - GPU_MEM_UTIL come only from measured nvidia-smi / vLLM logs (never invented)
 *  - --max-model-len bounded (16384 default), never native 256K
 *  - dedicated user redrob-vllm, dedicated ports, dedicated log paths
 *  - shared venv + HF cache across slots; one unit / port / measured.env per slot
 */

import {
  INSTALL_ROOT,
  LEGACY_MEASURED_ENV,
  LEGACY_UNIT,
  MAX_DEPLOY_SLOTS,
  SECRETS_ENV,
  SLOTS_ROOT,
  slotFor,
  type DeploySlot,
} from './slots';
import { deployPort } from './port';

/**
 * The service answers on every interface, so the workbench can call the host
 * directly instead of forwarding a port over SSH. `--api-key` is the whole of
 * the application-level access control.
 */
export const BIND_HOST = '0.0.0.0';

/** @deprecated Prefer slotFor(0).unit — kept for callers that still mean slot 0. */
export const UNIT = slotFor(0).unit;

/** Marker file naming the op currently in flight, so the UI can show it. */
export const RUNNING_MARKER = '/tmp/redrob-op.running';

function asSlot(slot?: DeploySlot | number): DeploySlot {
  if (typeof slot === 'object' && slot !== null) return slot;
  return slotFor(typeof slot === 'number' ? slot : 0);
}

/**
 * Keep a served slot reachable after reboots and redeploys.
 *
 * vLLM still requires its bearer token. This opens only the configured TCP
 * port, not SSH or any other service. Cloud firewalls such as an AWS security
 * group remain outside the host and must allow the same port separately.
 */
function openFirewallPort(port: number): string {
  return `if command -v ufw >/dev/null 2>&1; then
  ufw allow ${port}/tcp >/dev/null
  echo "FIREWALL_OPEN=${port}/tcp (ufw)"
elif command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port=${port}/tcp >/dev/null
  firewall-cmd --reload >/dev/null
  echo "FIREWALL_OPEN=${port}/tcp (firewalld)"
else
  echo "WARN: no ufw or firewalld found; ensure TCP ${port} is open externally"
fi`;
}

/** systemd unit content for one slot (restart on failure). */
export function unitFile(slot: DeploySlot | number = 0): string {
  const s = asSlot(slot);
  return `[Unit]
Description=Redrob vLLM slot ${s.index}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=redrob-vllm
Group=redrob-vllm
WorkingDirectory=${INSTALL_ROOT}

EnvironmentFile=-${SECRETS_ENV}
EnvironmentFile=${s.measuredEnv}

ExecStart=${s.serveScript}

Restart=on-failure
RestartSec=5
TimeoutStartSec=0

StandardOutput=append:${s.logFile}
StandardError=append:${s.logFile}

NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
# port ${s.port}
`;
}

/** serve wrapper installed to /opt/redrob-vllm/bin/serve-{n}.sh */
export function serveWrapper(slot: DeploySlot | number = 0): string {
  const s = asSlot(slot);
  return `#!/usr/bin/env bash
set -euo pipefail

: "\${VLLM_API_KEY:?VLLM_API_KEY required in secrets.env}"
: "\${MODEL_HF:?MODEL_HF required in measured.env}"
: "\${SERVED_MODEL_NAME:?SERVED_MODEL_NAME required in measured.env}"
: "\${GPU_MEM_UTIL:?GPU_MEM_UTIL required in measured.env}"
: "\${MAX_MODEL_LEN:?MAX_MODEL_LEN required in measured.env}"
: "\${MAX_NUM_SEQS:?MAX_NUM_SEQS required in measured.env}"
: "\${DTYPE:?DTYPE required in measured.env}"

EXTRA=()
if [[ -n "\${QUANTIZATION:-}" && "\${QUANTIZATION}" != "none" ]]; then
  EXTRA+=(--quantization "\${QUANTIZATION}")
fi
# Without this, util alone decides the KV pool and vLLM claims the whole
# fraction however small the model is: a 2B slot took 41 GiB of KV for a
# workload that needs about two. Measure sizes this from the cost per token it
# observed, so slots keep fitting on the card while there is memory left.
if [[ -n "\${KV_CACHE_MEMORY:-}" && "\${KV_CACHE_MEMORY}" != "0" ]]; then
  EXTRA+=(--kv-cache-memory "\${KV_CACHE_MEMORY}")
fi
# A thinking model whose chat template force-opens <think> streams its whole
# trace as the answer. The parser moves it to a separate \`reasoning\` field so
# \`content\` is the answer alone. Only set when Measure found the think tokens in
# the tokenizer: vLLM refuses to start with a parser it cannot find them for.
if [[ -n "\${REASONING_PARSER:-}" && "\${REASONING_PARSER}" != "none" ]]; then
  EXTRA+=(--reasoning-parser "\${REASONING_PARSER}")
fi

# flashinfer JIT-compiles kernels on the first load and shells out to a bare
# "ninja", which lives in the venv. systemd hands the unit a stock PATH, so
# without this the load dies once the weights are already on the card.
export PATH="${INSTALL_ROOT}/venv/bin:\${PATH}"

exec ${INSTALL_ROOT}/venv/bin/vllm serve "\${MODEL_HF}" \\
  --host ${BIND_HOST} \\
  --port ${s.port} \\
  --api-key "\${VLLM_API_KEY}" \\
  --served-model-name "\${SERVED_MODEL_NAME}" \\
  --dtype "\${DTYPE}" \\
  --gpu-memory-utilization "\${GPU_MEM_UTIL}" \\
  --max-model-len "\${MAX_MODEL_LEN}" \\
  --max-num-seqs "\${MAX_NUM_SEQS}" \\
  "\${EXTRA[@]}"
`;
}

/**
 * Install/provision (root). Writes shared user/venv/secrets once, migrates the
 * legacy single-slot measured.env into slots/0, and lays down the unit and
 * serve wrapper for every slot.
 *
 * Every slot, not only the one being set up: units and wrappers are generated
 * files with nothing model-specific in them, and provisioning them all here is
 * what makes adding a slot later a measurement rather than another install.
 * Nothing starts — a unit without that slot's measured.env refuses to.
 */
export function installScript(): string {
  const enc = (s: string) => Buffer.from(s, 'utf8').toString('base64');
  const slot0 = slotFor(0);
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
id -u redrob-vllm >/dev/null 2>&1 || useradd --system --home ${INSTALL_ROOT} --shell /usr/sbin/nologin redrob-vllm
mkdir -p ${INSTALL_ROOT}/bin ${INSTALL_ROOT}/hf-cache /etc/redrob-vllm ${SLOTS_ROOT} /var/log/redrob-vllm
chown -R redrob-vllm:redrob-vllm ${INSTALL_ROOT} /var/log/redrob-vllm
chmod 0755 /etc/redrob-vllm ${SLOTS_ROOT} /var/log/redrob-vllm

# secrets.env from injected env (never echoed). The tight umask stays inside the
# subshell: leaking it into the venv below makes the venv 0700, and then the
# status check, which runs as the login user, cannot see vLLM at all.
(
  umask 077
  cat > /tmp/redrob-secrets.env <<EOF
VLLM_API_KEY=\${VLLM_API_KEY}
HF_TOKEN=\${HF_TOKEN}
HUGGING_FACE_HUB_TOKEN=\${HF_TOKEN}
HF_HOME=${INSTALL_ROOT}/hf-cache
EOF
)
install -o root -g redrob-vllm -m 0640 /tmp/redrob-secrets.env ${SECRETS_ENV}
rm -f /tmp/redrob-secrets.env

# A host provisioned before the split was removed still has the two old units,
# and an enabled one would claim the card at boot and leave this one failing on
# memory, which reads as a problem with the model.
for old in redrob-vllm-s redrob-vllm-l; do
  systemctl disable --now "\${old}.service" 2>/dev/null || true
  rm -f "/etc/systemd/system/\${old}.service"
done
rm -f ${INSTALL_ROOT}/bin/serve-s.sh ${INSTALL_ROOT}/bin/serve-l.sh

# Pre-multi-slot single unit: stop it so slot-0 owns the port instead.
systemctl disable --now ${LEGACY_UNIT} 2>/dev/null || true
rm -f /etc/systemd/system/${LEGACY_UNIT}
rm -f ${INSTALL_ROOT}/bin/serve.sh

# Every slot directory up front and world-traversable: the status check runs as
# the login user, and it reports an unreadable slot as never measured.
for i in $(seq 0 ${MAX_DEPLOY_SLOTS - 1}); do
  mkdir -p ${SLOTS_ROOT}/"\${i}"
  chmod 0755 ${SLOTS_ROOT}/"\${i}"
done

# Host firewall rules are persistent. Open every supported slot now so adding
# slot 1 later cannot produce an active service that Compare cannot reach.
${Array.from({ length: MAX_DEPLOY_SLOTS }, (_, i) => openFirewallPort(slotFor(i).port)).join('\n')}

# Migrate legacy measured.env into slots/0 when the slot file is missing.
if [[ -f ${LEGACY_MEASURED_ENV} && ! -f ${slot0.measuredEnv} ]]; then
  cp -a ${LEGACY_MEASURED_ENV} ${slot0.measuredEnv}
  echo "NOTE: migrated ${LEGACY_MEASURED_ENV} -> ${slot0.measuredEnv}"
fi
if [[ -f ${slot0.measuredEnv} ]]; then chmod 0644 ${slot0.measuredEnv}; fi
if [[ -f ${LEGACY_MEASURED_ENV} ]]; then chmod 0644 ${LEGACY_MEASURED_ENV}; fi

${Array.from({ length: MAX_DEPLOY_SLOTS }, (_, i) => slotFor(i))
  .map(
    (s) => `echo '${enc(unitFile(s))}' | base64 -d > /etc/systemd/system/${s.unit}
echo '${enc(serveWrapper(s))}' | base64 -d > ${s.serveScript}
chmod 0644 /etc/systemd/system/${s.unit}
chmod 0755 ${s.serveScript}
chown root:redrob-vllm ${s.serveScript}
install -o redrob-vllm -g redrob-vllm -m 0644 /dev/null ${s.logFile} 2>/dev/null || true`,
  )
  .join('\n')}

if [[ ! -x ${INSTALL_ROOT}/venv/bin/vllm ]]; then
  echo "Installing vLLM into ${INSTALL_ROOT}/venv (first time)..."
  python3 -m venv ${INSTALL_ROOT}/venv
  ${INSTALL_ROOT}/venv/bin/pip install --upgrade pip wheel
  ${INSTALL_ROOT}/venv/bin/pip install vllm
  chown -R redrob-vllm:redrob-vllm ${INSTALL_ROOT}/venv
else
  echo "vLLM venv already present - leaving existing install untouched"
fi
# flashinfer builds kernels at load time and needs ninja. It usually arrives as
# a dependency, but a load that gets as far as the weights and then dies on a
# missing build tool is an expensive way to find out.
${INSTALL_ROOT}/venv/bin/python -c 'import shutil,sys; sys.exit(0 if shutil.which("ninja", path="${INSTALL_ROOT}/venv/bin") else 1)' \\
  || ${INSTALL_ROOT}/venv/bin/pip install -q ninja
# Repairs a venv laid down under the old umask. Nothing secret lives here; the
# status check reads it as the login user and reports Install as never run
# otherwise.
chmod -R a+rX ${INSTALL_ROOT}/venv

systemctl daemon-reload
# Not enabled here: without a usable measured.env the unit would fail at boot.
if [[ ! -f ${slot0.measuredEnv} ]] || ! grep -qE '^GPU_MEM_UTIL=' ${slot0.measuredEnv}; then
  echo "NOTE: slot 0 measured.env not usable yet - the service will refuse to start until Measure runs."
  systemctl stop ${slot0.unit} 2>/dev/null || true
fi
echo "INSTALL_OK"
echo "INSTALL_ROOT=${INSTALL_ROOT}"
echo "HOST_HINT=slots live under ${SLOTS_ROOT}/<n>/measured.env; shared secrets at ${SECRETS_ENV}"
`;
}

/** systemctl start/stop for one slot (root). Restart is stop then start, no separate op. */
export function serviceControl(
  action: 'start' | 'stop',
  slot: DeploySlot | number = 0,
): string {
  const s = asSlot(slot);
  const enc = (text: string) => Buffer.from(text, 'utf8').toString('base64');
  if (action === 'stop') {
    return `set -euo pipefail
systemctl stop ${s.unit} 2>/dev/null || true
echo "STOP_OK"
echo "SLOT=${s.index}"
`;
  }
  return `set -euo pipefail
if [[ ! -f ${s.measuredEnv} ]]; then
  echo "ERROR: ${s.measuredEnv} missing - run Measure first" >&2
  exit 1
fi
if ! grep -qE '^GPU_MEM_UTIL=' ${s.measuredEnv}; then
  echo "ERROR: measured.env has no util for the model - run Measure first" >&2
  exit 1
fi
if [[ ! -d ${INSTALL_ROOT}/bin ]]; then
  echo "ERROR: ${INSTALL_ROOT} is missing - run Install first" >&2
  exit 1
fi
mkdir -p ${SLOTS_ROOT}/${s.index} /var/log/redrob-vllm
chmod 0755 ${SLOTS_ROOT}/${s.index}
chmod 0644 ${s.measuredEnv} 2>/dev/null || true
install -o redrob-vllm -g redrob-vllm -m 0644 /dev/null ${s.logFile} 2>/dev/null || true
# The unit and the wrapper are generated, not configuration, so they are laid
# down again on every start. A host provisioned by an older build still binds
# loopback, which would come up and answer nothing from here; making that the
# user's problem to fix by re-running Install only moved the work.
echo '${enc(unitFile(s))}' | base64 -d > /etc/systemd/system/${s.unit}
echo '${enc(serveWrapper(s))}' | base64 -d > ${s.serveScript}
chmod 0644 /etc/systemd/system/${s.unit}
chmod 0755 ${s.serveScript}
chown root:redrob-vllm ${s.serveScript}
systemctl daemon-reload
# Reassert the persistent host-firewall rule on every start. This repairs hosts
# installed before multi-slot firewall provisioning was added.
${openFirewallPort(s.port)}
systemctl enable ${s.unit} 2>/dev/null || true
systemctl restart ${s.unit}
systemctl is-active ${s.unit} || true
echo "NOTE: listening on ${BIND_HOST}:${s.port} as ${s.servedName}; persistent host-firewall access enabled. VLLM_API_KEY is required."
echo "START_OK"
echo "SLOT=${s.index}"
echo "PORT=${s.port}"
`;
}

/**
 * Stop one slot's unit and remove its unit file, wrapper, and measured.env dir.
 * Leaves the shared venv, HF cache, and secrets.env alone.
 */
export function undeployScript(slot: DeploySlot | number = 0): string {
  const s = asSlot(slot);
  return `set -euo pipefail
systemctl disable --now ${s.unit} 2>/dev/null || true
rm -f /etc/systemd/system/${s.unit}
rm -f ${s.serveScript}
rm -rf ${SLOTS_ROOT}/${s.index}
systemctl daemon-reload 2>/dev/null || true
echo "UNDEPLOY_OK"
echo "SLOT=${s.index}"
echo "NOTE: shared install at ${INSTALL_ROOT} and secrets at ${SECRETS_ENV} were left in place"
`;
}

/**
 * Undeploy every slot in one pass, and drop the downloaded weights with it.
 *
 * The shared venv and secrets stay: the expensive part of Install is the vLLM
 * install, and a host that has to be provisioned again to try one more model
 * is a host nobody clears. The HF cache is the disk hog, so it goes.
 */
export function purgeAllScript(): string {
  const slots = Array.from({ length: MAX_DEPLOY_SLOTS }, (_, i) => slotFor(i));
  const perSlot = slots
    .map(
      (s) => `systemctl disable --now ${s.unit} 2>/dev/null || true
rm -f /etc/systemd/system/${s.unit}
rm -f ${s.serveScript}
rm -rf ${SLOTS_ROOT}/${s.index}
echo "REMOVED_SLOT=${s.index}"`,
    )
    .join('\n');

  return `set -euo pipefail
${perSlot}
# The pre-multi-slot unit too, so an old host is left as clean as a new one.
systemctl disable --now ${LEGACY_UNIT} 2>/dev/null || true
rm -f /etc/systemd/system/${LEGACY_UNIT}
rm -f ${LEGACY_MEASURED_ENV}
systemctl daemon-reload 2>/dev/null || true

if [[ -d ${INSTALL_ROOT}/hf-cache ]]; then
  before="$(du -sh ${INSTALL_ROOT}/hf-cache 2>/dev/null | cut -f1)"
  rm -rf ${INSTALL_ROOT}/hf-cache
  mkdir -p ${INSTALL_ROOT}/hf-cache
  chown redrob-vllm:redrob-vllm ${INSTALL_ROOT}/hf-cache
  echo "REMOVED_WEIGHTS=\${before:-unknown}"
fi
echo "PURGE_OK"
echo "NOTE: venv at ${INSTALL_ROOT}/venv and secrets at ${SECRETS_ENV} were left in place. Measure re-downloads weights."
`;
}

/**
 * Stop the op in flight and leave nothing holding the GPU.
 *
 * Targets the op script and the pids the measure step recorded, never a port,
 * so a serving unit that happens to own the configured port is not caught in
 * the blast. The bracket in the pkill pattern keeps this script from matching
 * its own command line and killing itself.
 */
export function cancelScript(): string {
  return `set +e
kill_group() {
  local pid="$1" sig="$2"
  [[ -z "$pid" ]] && return 1
  # vLLM forks workers, so signal the whole group or the children survive.
  local pgid; pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -dc '0-9')"
  if [[ -n "$pgid" ]]; then kill -"$sig" -"$pgid" 2>/dev/null; else kill -"$sig" "$pid" 2>/dev/null; fi
}
hit=0
pkill -TERM -f 'bash /tmp/redrob[-]op-' 2>/dev/null && hit=1
pids=()
for f in /tmp/redrob-vllm-measure/pid-*; do
  [[ -f "\${f}" ]] || continue
  p="$(tr -dc '0-9' < "\${f}" 2>/dev/null)"
  [[ -z "\${p}" ]] && continue
  pids+=("\${p}")
  kill_group "\${p}" TERM && hit=1
done
sleep 3
pkill -KILL -f 'bash /tmp/redrob[-]op-' 2>/dev/null
for p in \${pids[@]+"\${pids[@]}"}; do kill_group "\${p}" KILL; done
rm -f /tmp/redrob-vllm-measure/pid-*
rm -f ${RUNNING_MARKER}
rm -f /tmp/redrob-op-*.sh
echo "CANCEL_HIT=\${hit}"
echo "CANCEL_OK"
`;
}

/** Service + GPU status for every slot (non-root ok). */
export function statusScript(): string {
  const base = deployPort();
  const indexes = Array.from({ length: MAX_DEPLOY_SLOTS }, (_, i) => i);
  const loop = indexes
    .map((i) => {
      const s = slotFor(i);
      const legacyFallback =
        i === 0
          ? `
  if [[ ! -f "\${envf}" && -f ${LEGACY_MEASURED_ENV} ]]; then envf=${LEGACY_MEASURED_ENV}; fi`
          : '';
      return `
envf=${s.measuredEnv}${legacyFallback}
echo "SLOT${i}_PORT=${s.port}"
echo "SLOT${i}_UNIT=${s.unit}"
echo "SLOT${i}_SERVED_NAME=${s.servedName}"
echo "SLOT${i}_MEASURED_ENV=\${envf}"
echo "SLOT${i}_SERVE_SCRIPT=${s.serveScript}"
echo "SLOT${i}_LOG=${s.logFile}"
echo "SLOT${i}_ACTIVE=$(systemctl is-active ${s.unit} 2>/dev/null)"
echo "SLOT${i}_ENABLED=$(systemctl is-enabled ${s.unit} 2>/dev/null)"
if [[ -f "\${envf}" ]]; then
  echo "SLOT${i}_MEASURED=1"
  while IFS= read -r line; do
    case "$line" in
      GPU_MEM_UTIL=*|MAX_MODEL_LEN=*|MAX_NUM_SEQS=*|DTYPE=*|QUANTIZATION=*|MEASURED_*|SERVED_MODEL_NAME=*|MODEL_HF=*|GPU_TOTAL_MIB=*|FREE_MIB=*|WEIGHT_MIB=*|MEASURED_AT=*)
        echo "SLOT${i}_\${line}"
        ;;
    esac
  done < "\${envf}"
else
  echo "SLOT${i}_MEASURED=0"
  # A measurement written under a tight umask leaves the slot directory
  # root-only, and this check runs as the login user. Saying so beats
  # reporting a measured slot as never measured.
  if [[ -e ${SLOTS_ROOT}/${i} && ! -x ${SLOTS_ROOT}/${i} ]]; then
    echo "SLOT${i}_UNREADABLE=1"
  fi
fi`;
    })
    .join('\n');

  return `set +e
echo "HOST=$(hostname -f 2>/dev/null || hostname || true)"
echo "INSTALL_ROOT=${INSTALL_ROOT}"
echo "PORT_BASE=${base}"
echo "MAX_SLOTS=${MAX_DEPLOY_SLOTS}"
# Legacy single-slot keys (slot 0) so older UI/status parsers still work.
echo "SERVICE_ACTIVE=$(systemctl is-active ${slotFor(0).unit} 2>/dev/null)"
echo "SERVICE_ENABLED=$(systemctl is-enabled ${slotFor(0).unit} 2>/dev/null)"
# "Has Install run" is answered by what Install puts there, not by a unit being
# enabled, which only happens once a model has been measured.
if [[ -x ${INSTALL_ROOT}/venv/bin/vllm ]]; then echo "VLLM_INSTALLED=1"; else echo "VLLM_INSTALLED=0"; fi
if command -v tmux >/dev/null 2>&1; then
  echo "TMUX_PRESENT=1"
  if tmux has-session -t redrob 2>/dev/null; then echo "TMUX_SESSION=1"; else echo "TMUX_SESSION=0"; fi
else
  echo "TMUX_PRESENT=0"
  echo "TMUX_SESSION=0"
fi
# A step already in flight (survives disconnects) - UI shows it instead of re-offering.
# Line 2 holds the pid of the shell running it. Without that liveness check a
# killed pane leaves the marker behind and the UI waits on an op that is gone.
if [[ -f ${RUNNING_MARKER} ]]; then
  MARKER_OP="$(sed -n 1p ${RUNNING_MARKER} 2>/dev/null)"
  MARKER_PID="$(sed -n 2p ${RUNNING_MARKER} 2>/dev/null | tr -dc '0-9')"
  if [[ -n "$MARKER_PID" ]] && kill -0 "$MARKER_PID" 2>/dev/null; then
    echo "RUNNING_OP=$MARKER_OP"
  else
    rm -f ${RUNNING_MARKER} 2>/dev/null
    [[ -n "$MARKER_OP" ]] && echo "STALE_OP=$MARKER_OP"
  fi
fi
if [[ -f ${slotFor(0).measuredEnv} || -f ${LEGACY_MEASURED_ENV} ]]; then echo "MEASURED_PRESENT=1"; else echo "MEASURED_PRESENT=0"; fi
if command -v nvidia-smi >/dev/null 2>&1; then
  echo "GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -n1)"
  echo "GPU_TOTAL_MIB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -n1 | tr -d ' ')"
  echo "GPU_USED_MIB=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits | head -n1 | tr -d ' ')"
  echo "GPU_FREE_MIB=$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits | head -n1 | tr -d ' ')"
fi
${loop}
# Flat keys from slot 0 for applyRemoteMeasured / older consumers.
env0=${slotFor(0).measuredEnv}
if [[ ! -f "\${env0}" && -f ${LEGACY_MEASURED_ENV} ]]; then env0=${LEGACY_MEASURED_ENV}; fi
if [[ -f "\${env0}" ]]; then
  grep -E '^(GPU_MEM_UTIL|MAX_MODEL_LEN|MAX_NUM_SEQS|DTYPE|QUANTIZATION|MEASURED_|SERVED_MODEL_NAME|MODEL_HF|GPU_TOTAL_MIB|FREE_MIB|WEIGHT_MIB|MEASURED_AT)=' "\${env0}" || true
fi
echo "STATUS_OK"
`;
}

/**
 * Readiness (long, cold-start-tolerant) + liveness (short completion) + warmup.
 * Runs against the live systemd service for the slot on 127.0.0.1.
 */
export function healthScript(
  servedName: string,
  readyTimeoutSec = 600,
  slot: DeploySlot | number = 0,
): string {
  const s = asSlot(slot);
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
echo "==> readiness (127.0.0.1:${s.port}) slot ${s.index}"
if ready ${s.port}; then echo "READY=1"; else echo "READY=0"; fi
echo "==> warmup + liveness"
if complete ${s.port} '${servedName}'; then echo "LIVE=1"; else echo "LIVE=0"; fi
echo "HEALTH_OK"
echo "SLOT=${s.index}"
`;
}

/**
 * Health for several slots at once.
 *
 * These are independent HTTP calls to ports that are already serving, so they
 * genuinely can run at the same time — unlike Measure, where each slot has to
 * have the card to itself to be sized. Output is buffered per slot and printed
 * in slot order, because interleaved curl output from four ports is unreadable.
 */
export function healthAllScript(
  targets: Array<{ slot: DeploySlot; servedName: string }>,
  readyTimeoutSec = 600,
): string {
  if (targets.length === 0) {
    return `set +e\necho "No slot is serving, so there is nothing to check."\necho "HEALTH_OK"\n`;
  }
  const enc = (text: string) => Buffer.from(text, 'utf8').toString('base64');
  const launch = targets
    .map(
      ({ slot, servedName }) => `echo '${enc(healthScript(servedName, readyTimeoutSec, slot))}' \\
  | base64 -d > "\${OUT_DIR}/slot-${slot.index}.sh"
bash "\${OUT_DIR}/slot-${slot.index}.sh" > "\${OUT_DIR}/slot-${slot.index}.log" 2>&1 &
PIDS+=($!)`,
    )
    .join('\n');
  const report = targets
    .map(
      ({ slot }) => `echo "---- slot ${slot.index} (:${slot.port}) ----"
cat "\${OUT_DIR}/slot-${slot.index}.log"`,
    )
    .join('\n');

  return `set +e
KEY="\${VLLM_API_KEY}"
export VLLM_API_KEY="\${KEY}"
OUT_DIR="$(mktemp -d /tmp/redrob-health-XXXXXX)"
trap 'rm -rf "\${OUT_DIR}"' EXIT
PIDS=()
echo "==> checking ${targets.length} slot(s) at once"
${launch}
for pid in \${PIDS[@]+"\${PIDS[@]}"}; do wait "\${pid}"; done
${report}
echo "HEALTH_ALL_OK"
`;
}

/**
 * Throughput benchmark for relative cost.
 * relativeCostWeight(m) = 100 * (tok_per_sec_large / tok_per_sec_m).
 * Measures output tok/s and persists it into that slot's measured.env so it
 * survives restarts and reaches Eval through the status poll (root needed).
 */
export function benchmarkScript(
  servedName: string,
  maxTokens = 256,
  slot: DeploySlot | number = 0,
): string {
  const s = asSlot(slot);
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
echo "==> benchmark slot ${s.index} on :${s.port}"
OUT=$(bench ${s.port} '${servedName}')
echo "$OUT"

TOKPS="$(echo "$OUT" | grep '^TOKPS=' | cut -d= -f2-)"
if [[ -n "\${TOKPS}" && -f ${s.measuredEnv} ]]; then
  sed -i '/^MEASURED_TOK_PER_SEC=/d' ${s.measuredEnv}
  printf 'MEASURED_TOK_PER_SEC=%s\\n' "\${TOKPS}" >> ${s.measuredEnv}
  echo "measured.env updated with tok/s"
else
  echo "WARN: tok/s not recorded (missing measured.env or benchmark failed)" >&2
fi
echo "BENCH_OK"
echo "SLOT=${s.index}"
`;
}
