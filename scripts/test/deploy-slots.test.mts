/**
 * Offline unit tests for multi-slot deploy path/port math.
 * Run: yarn test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_DEPLOY_SLOTS,
  allSlotIndexes,
  slotFor,
} from '../../apps/web/src/lib/deploy/slots.ts';
import {
  healthAllScript,
  installScript,
  purgeAllScript,
  serveWrapper,
  serviceControl,
  statusScript,
  undeployScript,
  unitFile,
} from '../../apps/web/src/lib/deploy/remote.ts';
import {
  measureAllScript,
  measureScript,
} from '../../apps/web/src/lib/deploy/remote-measure.ts';
import { classifyReachFailure } from '../../apps/web/src/lib/deploy/reachability.ts';
import { vllmSlotEndpoints } from '../../packages/harness/src/config/self-hosted.ts';

test('what Deploy serves is exactly what the catalog goes looking for', () => {
  // The catalog derives slot endpoints from VLLM_BASE_URL alone, so if either
  // side changes its port step or alias, a deployed model silently stops
  // appearing in Compare. That was the original bug, so it gets a test.
  const before = process.env.VLLM_PORT;
  try {
    process.env.VLLM_PORT = '8101';
    const derived = vllmSlotEndpoints({ VLLM_BASE_URL: 'http://gpu.example:8101/v1' });
    assert.equal(derived.length, MAX_DEPLOY_SLOTS);
    for (const index of allSlotIndexes()) {
      const slot = slotFor(index);
      assert.equal(derived[index]?.servedName, slot.servedName);
      assert.equal(derived[index]?.baseUrl, `http://gpu.example:${slot.port}/v1`);
    }
  } finally {
    if (before === undefined) delete process.env.VLLM_PORT;
    else process.env.VLLM_PORT = before;
  }
});

test('slotFor maps index to port, unit, paths, and served name', () => {
  const before = process.env.VLLM_PORT;
  try {
    delete process.env.VLLM_PORT;
    const s0 = slotFor(0);
    assert.equal(s0.port, 8000);
    assert.equal(s0.unit, 'redrob-vllm-s0.service');
    assert.equal(s0.servedName, 'redrob-s0');
    assert.equal(s0.measuredEnv, '/etc/redrob-vllm/slots/0/measured.env');
    assert.equal(s0.serveScript, '/opt/redrob-vllm/bin/serve-0.sh');
    assert.equal(s0.logFile, '/var/log/redrob-vllm/serve-0.log');

    const s1 = slotFor(1);
    assert.equal(s1.port, 8001);
    assert.equal(s1.unit, 'redrob-vllm-s1.service');
    assert.equal(s1.servedName, 'redrob-s1');
    assert.equal(s1.serveScript, '/opt/redrob-vllm/bin/serve-1.sh');
  } finally {
    if (before === undefined) delete process.env.VLLM_PORT;
    else process.env.VLLM_PORT = before;
  }
});

test('slot indexes cover 0..MAX-1 and reject out of range', () => {
  assert.deepEqual(allSlotIndexes(), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(MAX_DEPLOY_SLOTS, 8);
  assert.throws(() => slotFor(-1));
  assert.throws(() => slotFor(MAX_DEPLOY_SLOTS));
});

test('slot 1 remote builders use base+1 port and s1 unit', () => {
  const before = process.env.VLLM_PORT;
  try {
    delete process.env.VLLM_PORT;
    assert.match(serveWrapper(1), /--port 8001/);
    assert.match(unitFile(1), /redrob-vllm-s1|serve-1\.sh|slots\/1\/measured\.env/);
    assert.match(serviceControl('start', 1), /redrob-vllm-s1\.service/);
    assert.match(serviceControl('start', 1), /listening on 0\.0\.0\.0:8001/);
    assert.match(serviceControl('start', 1), /ufw allow 8001\/tcp/);
    assert.match(serviceControl('start', 1), /firewall-cmd --permanent --add-port=8001\/tcp/);
    assert.match(installScript(), /ufw allow 8000\/tcp/);
    assert.match(installScript(), /ufw allow 8001\/tcp/);
    assert.match(installScript(), /ufw allow 8007\/tcp/);
    assert.match(installScript(), /seq 0 7/);
    assert.match(undeployScript(1), /UNDEPLOY_OK/);
    assert.match(undeployScript(1), /redrob-vllm-s1\.service/);

    const measure = measureScript({
      model: 'org/model',
      servedName: 'redrob-s1',
      maxModelLen: 8192,
      maxNumSeqs: 8,
      slot: 1,
    });
    assert.match(measure, /PORT=8001/);
    assert.match(measure, /slots\/1\/measured\.env/);
    assert.match(measure, /redrob-vllm-s1\.service/);
  } finally {
    if (before === undefined) delete process.env.VLLM_PORT;
    else process.env.VLLM_PORT = before;
  }
});

test('a thinking model gets its trace split off by the server', () => {
  const wrapper = serveWrapper(0);
  // Passed only when Measure found the tokens: vLLM refuses to start with a
  // parser whose think tokens are not in the tokenizer, which would take a
  // non-thinking model like Gemma down with it.
  assert.match(wrapper, /REASONING_PARSER/);
  assert.match(wrapper, /--reasoning-parser/);
  assert.match(wrapper, /"\$\{REASONING_PARSER\}" != "none"/);

  const measure = measureScript({
    model: 'org/model',
    servedName: 'redrob-s0',
    maxModelLen: 8192,
    maxNumSeqs: 8,
    slot: 0,
  });
  assert.match(measure, /detect_reasoning_parser/);
  assert.match(measure, /deepseek_r1/);
  // Recorded next to the other serve settings, so Start picks it up.
  assert.match(measure, /echo "REASONING_PARSER=\$\{REASONING_PARSER\}"/);
  assert.match(measure, /RESULT_REASONING_PARSER=/);
});

test('a measured slot directory stays readable by the status check', () => {
  const measure = measureScript({
    model: 'org/model',
    servedName: 'redrob-s1',
    maxModelLen: 8192,
    maxNumSeqs: 8,
    slot: 1,
  });
  // umask 077 during the write left slots/1 root-only, and the non-root status
  // poll then reported the slot as never measured, blocking Start.
  assert.match(measure, /chmod 0755 "\$\(dirname "\$\{MEASURED_ENV\}"\)"/);
  // util is sized from free VRAM and soft-capped at half the card, so the first
  // slot on an empty GPU leaves room and later slots take what is left. A
  // 1/MAX_SLOTS share would shrink every claim as the ceiling rose.
  assert.match(measure, /single_share = 0\.50/);
  assert.match(measure, /frac = min\(from_free, single_share\)/);
  assert.doesNotMatch(measure, /per_slot_cap/);
  assert.match(installScript(), /chmod 0755 \/etc\/redrob-vllm\/slots\/"\$\{i\}"/);
  assert.match(serviceControl('start', 1), /chmod 0755 \/etc\/redrob-vllm\/slots\/1/);
  assert.match(statusScript(), /SLOT1_UNREADABLE=1/);
});

test('a refused port is told apart from a blocked one', () => {
  // Both used to print the same "open the firewall port" advice, which sent
  // people after a rule that was already there while vLLM was merely loading.
  assert.equal(classifyReachFailure('connect ECONNREFUSED 203.0.113.10:8101'), 'refused');
  assert.equal(classifyReachFailure('No response from http://h:8102/v1 within 2500 ms'), 'blocked');
  assert.equal(classifyReachFailure('connect ETIMEDOUT 203.0.113.10:8102'), 'blocked');
  assert.equal(classifyReachFailure(null), 'unknown');
});

test('a served slot is sized to its workload, not to the whole card', () => {
  // vLLM turns util into a static KV pool, so a 2B model on a free card
  // reserved 41 GiB of KV and two slots filled a 96 GiB card. Measure now reads
  // the cost per token back out of the probe log and serves with a bounded pool.
  const measure = measureScript({
    model: 'org/model',
    servedName: 'redrob-s2',
    maxModelLen: 16384,
    maxNumSeqs: 8,
    slot: 2,
  });
  assert.match(measure, /size_serve_from_probe/);
  assert.match(measure, /Available KV cache memory/);
  assert.match(measure, /GPU KV cache size/);
  // The regex backslashes must survive the template literal; \s collapsing to s
  // was what left KV_CACHE_MEMORY empty and the pool full-sized.
  assert.match(measure, /Available KV cache memory:\\s\*\(\[0-9\.\]\+\)\\s\*GiB/);
  assert.match(measure, /echo "KV_CACHE_MEMORY=\$\{KV_CACHE_MEMORY\}"/);
  assert.match(measure, /RESULT_KV_CACHE_MEMORY=/);
  // Provenance: the probe runs big on purpose, and what it ran at is recorded.
  assert.match(measure, /PROBE_GPU_MEM_UTIL=/);

  const wrapper = serveWrapper(2);
  assert.match(wrapper, /--kv-cache-memory/);
  assert.match(wrapper, /"\$\{KV_CACHE_MEMORY:-\}"/);
});

test('a probe that loses the memory race re-reads free VRAM instead of blaming the model', () => {
  // Measuring slot 3 while slot 1 restarted saw 84 GiB free, asked for half the
  // card, and vLLM refused once the other slot was back. Reading free VRAM once
  // up front is what made a 350M model look too big for an idle card.
  const measure = measureScript({
    model: 'org/model',
    servedName: 'redrob-s3',
    maxModelLen: 16384,
    maxNumSeqs: 8,
    slot: 3,
  });
  assert.match(measure, /GPU_MEM_UTIL="\$\(compute_util\)"/);
  assert.match(measure, /is less than desired GPU memory utilization/);
  assert.match(measure, /if util_race && \(\( attempt < 3 \)\); then/);
  // The FP8 retry is for weights that do not fit, so the race must not spend it.
  assert.match(measure, /if \[\[ "\$\{QUANT\}" == "none" \]\]; then/);
  assert.match(measure, /\(\( LOADED == 1 \)\) \|\|/);
});

test('install provisions every slot, not only the one being set up', () => {
  // A unit and a wrapper hold nothing model-specific, so laying them all down
  // here is what makes adding slot 3 later a measurement rather than a reinstall.
  const script = installScript();
  for (const i of allSlotIndexes()) {
    assert.match(script, new RegExp(`/etc/systemd/system/redrob-vllm-s${i}\\.service`));
    assert.match(script, new RegExp(`/opt/redrob-vllm/bin/serve-${i}\\.sh`));
  }
  // Still nothing started: a unit without that slot's measured.env refuses to.
  assert.doesNotMatch(script, /systemctl (start|enable) redrob-vllm-s/);
});

test('measuring every slot downloads in parallel and sizes one at a time', () => {
  // Sizing reads the VRAM actually free at that moment, so two probes loading
  // together would each claim memory the other was about to take. The download
  // is where the wall time goes, and that is network-bound, so it overlaps.
  const steps = [0, 1, 2].map((index) => ({
    slot: slotFor(index),
    model: `org/model-${index}`,
    body: `echo "slot ${index} body"`,
  }));
  const script = measureAllScript(steps);

  assert.match(script, /snapshot_download/);
  assert.match(script, /PREFETCH_PIDS\+=\(\$!\)/);
  assert.match(script, /for pid in \$\{PREFETCH_PIDS\[@\]\+"\$\{PREFETCH_PIDS\[@\]\}"\}; do wait/);
  for (const step of steps) {
    assert.match(script, new RegExp(`prefetch '${step.model}' &`));
  }

  // Every per-slot body runs in its own foreground bash, in slot order.
  const runs = [...script.matchAll(/bash "\$\{WORK_DIR\}\/slot-(\d)\.sh"/g)].map((m) => m[1]);
  assert.deepEqual(runs, ['0', '1', '2'], 'slots are measured in order, one at a time');
  assert.doesNotMatch(script, /slot-\d\.sh" &/, 'no slot is measured in the background');

  // One model that does not fit is not a reason to leave the rest unmeasured.
  assert.match(script, /FAILED\+=\("1"\)/);
  assert.match(script, /MEASURE_ALL_PARTIAL/);
  assert.match(script, /MEASURE_ALL_OK/);
});

test('measuring every slot is nothing to do when no slot has a model', () => {
  assert.match(measureAllScript([]), /No slot has a model to measure/);
});

test('health does run every slot at once, and prints them in order', () => {
  // Unlike Measure, these are independent HTTP calls to ports already serving.
  const script = healthAllScript(
    [0, 2].map((index) => ({ slot: slotFor(index), servedName: `redrob-s${index}` })),
  );
  assert.match(script, /PIDS\+=\(\$!\)/);
  assert.match(script, /slot-0\.sh" > "\$\{OUT_DIR\}\/slot-0\.log" 2>&1 &/);
  assert.match(script, /slot-2\.sh" > "\$\{OUT_DIR\}\/slot-2\.log" 2>&1 &/);
  assert.match(script, /for pid in \$\{PIDS\[@\]\+"\$\{PIDS\[@\]\}"\}; do wait/);
  // Interleaved curl output from four ports is unreadable, so it is buffered.
  const printed = [...script.matchAll(/---- slot (\d) \(:\d+\) ----/g)].map((m) => m[1]);
  assert.deepEqual(printed, ['0', '2']);
  assert.match(healthAllScript([]), /nothing to check/);
});

test('each slot in a whole-host measure keeps its own model and port', () => {
  const script = measureAllScript(
    [0, 1].map((index) => ({
      slot: slotFor(index),
      model: `org/model-${index}`,
      body: measureScript({
        model: `org/model-${index}`,
        servedName: `redrob-s${index}`,
        maxModelLen: 8192,
        maxNumSeqs: 8,
        slot: index,
      }),
    })),
  );
  const bodies = [...script.matchAll(/echo '([A-Za-z0-9+/=]+)' \| base64 -d/g)].map((m) =>
    Buffer.from(m[1]!, 'base64').toString('utf8'),
  );
  assert.equal(bodies.length, 2, 'one measure body per slot');
  assert.match(bodies[0]!, /MODEL='org\/model-0'/);
  assert.match(bodies[0]!, /slots\/0\/measured\.env/);
  assert.match(bodies[1]!, /MODEL='org\/model-1'/);
  assert.match(bodies[1]!, /slots\/1\/measured\.env/);
});

test('purge clears every slot and the weight cache, keeps the venv', () => {
  const script = purgeAllScript();
  for (const i of allSlotIndexes()) {
    assert.match(script, new RegExp(`redrob-vllm-s${i}\\.service`));
    assert.match(script, new RegExp(`REMOVED_SLOT=${i}`));
  }
  assert.match(script, /rm -rf \/opt\/redrob-vllm\/hf-cache/);
  assert.doesNotMatch(script, /rm -rf \/opt\/redrob-vllm\/venv/);
  assert.match(script, /PURGE_OK/);
});
