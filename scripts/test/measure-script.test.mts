/**
 * The measure step is a bash script assembled in TypeScript and run as root on
 * the GPU host, where a typo costs a fifteen minute round trip to find. These
 * tests parse it and pin the properties that were each a real failure.
 * Run: yarn test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { measureScript } from '../../apps/web/src/lib/deploy/remote-measure.ts';
import { installScript, serveWrapper, serviceControl } from '../../apps/web/src/lib/deploy/remote.ts';

const script = measureScript({
  model: 'org/some-it',
  servedName: 'redrob-s0',
  maxModelLen: 8192,
  maxNumSeqs: 8,
});

/** Comments mention the calls they explain, and would match otherwise. */
function activeLines(text: string): string[] {
  return text.split('\n').filter((line) => !line.trimStart().startsWith('#'));
}

/** Everything after the helper definitions, so a definition is not read as a call. */
function mainBody(text: string): string {
  const at = text.indexOf('echo "==> measure starting');
  assert.notEqual(at, -1, 'the script no longer has a recognisable main body');
  return text.slice(at);
}

function checkBash(text: string, name: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'redrob-measure-'));
  const file = path.join(dir, `${name}.sh`);
  writeFileSync(file, text);
  const res = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
  if (res.error) return; // no bash on this machine, nothing to check
  assert.equal(res.status, 0, `bash -n rejected ${name}:\n${res.stderr}`);
}

test('the generated script is valid bash', () => {
  checkBash(script, 'measure');
  checkBash(serviceControl('start', 0), 'start');
  checkBash(serviceControl('stop', 0), 'stop');
});

test('there is a primary measure port, and slot 0 defaults to it', () => {
  assert.match(script, /PORT=8000/);
  const strays = activeLines(script).filter((line) => /\b8102\b/.test(line));
  assert.deepEqual(strays, [], 'the measure script still touches the retired port');
});

test('the conventional port defaults to 8000 and can be overridden', () => {
  const before = process.env.VLLM_PORT;
  try {
    delete process.env.VLLM_PORT;
    assert.match(measureScript({ model: 'org/model', servedName: 'redrob-s0', maxModelLen: 8, maxNumSeqs: 1 }), /PORT=8000/);
    process.env.VLLM_PORT = '8101';
    // Port is baked into wrappers at call time from env.
    assert.match(serveWrapper(0), /--port 8101/);
    assert.match(serviceControl('start', 0), /listening on 0\.0\.0\.0:8101/);
  } finally {
    if (before === undefined) delete process.env.VLLM_PORT;
    else process.env.VLLM_PORT = before;
  }
});

test('one model means one load, not a sizing pass and then a rerun', () => {
  // The util is whatever headroom leaves no matter what the weights come to,
  // so a separate sizing pass would only spend a second cold start to learn it.
  // The lone extra load is the FP8 retry, which runs only after a failure.
  const loads = activeLines(mainBody(script)).filter((line) => /^\s*start_probe\b/.test(line));
  assert.equal(loads.length, 1, `expected a single load, got:\n${loads.join('\n')}`);
  assert.match(script, /one retry with FP8/);
});

test('measured.env is rewritten whole, with nothing carried over', () => {
  // Every value in it describes the weights that were on the card, so a
  // leftover from the model before would be a util measured on something else.
  assert.ok(!/CARRIED/.test(script), 'the script still carries values across models');
  assert.match(script, /^\s*echo "GPU_MEM_UTIL=/m);
  assert.match(script, /^\s*echo "MODEL_HF=/m);
  assert.ok(!/GPU_MEM_UTIL_[SL]/.test(script), 'axis-suffixed keys are back');
});

test('starting refuses when the model has no measured util', () => {
  assert.match(serviceControl('start', 0), /GPU_MEM_UTIL=.*run Measure first/s);
  assert.match(serviceControl('start', 0), /systemctl restart redrob-vllm-s0\.service/);
});

test('install clears the units from when there were two', () => {
  // An enabled old unit would claim the card at boot and the one model would
  // then fail on memory, blaming a model that was never the problem.
  const install = installScript();
  assert.match(install, /for old in redrob-vllm-s redrob-vllm-l/);
  assert.match(install, /systemctl disable --now/);
  assert.match(install, /\/etc\/redrob-vllm\/slots/);
  checkBash(install, 'install');
});

test('the venv stays readable to whoever runs the status check', () => {
  // The secrets umask used to leak into `python3 -m venv`, leaving the venv
  // 0700. Install then said OK while the status check, which is not root,
  // reported vLLM missing and Measure never unblocked.
  const install = installScript();
  const umaskLines = activeLines(install).filter((line) => /umask/.test(line));
  for (const line of umaskLines) {
    assert.match(line, /^\s{2,}umask/, `umask escaped its subshell: ${line}`);
  }
  assert.match(install, /chmod -R a\+rX \/opt\/redrob-vllm\/venv/);
});

test('the measurement is readable by whoever runs the status check', () => {
  // At 0640 the status check, which is not root and not in the service group,
  // read nothing from it, so Serve stayed blocked on a measurement that had
  // already happened. There are no secrets in this file.
  assert.match(script, /chmod 0644 "\$\{MEASURED_ENV\}"/);
  assert.match(installScript(), /chmod 0644 \/etc\/redrob-vllm\/slots\/0\/measured\.env/);
});

test('the venv is on PATH wherever vLLM is launched', () => {
  // flashinfer compiles kernels on the first load and shells out to a bare
  // "ninja", which only exists in the venv. Calling vllm by absolute path is
  // not enough, and the failure lands after the weights are on the card.
  assert.match(script, /PATH="\$\{PROBE_PATH\}"/);
  assert.match(script, /PROBE_PATH="\$\{VENV_BIN\}:/);
  assert.match(serveWrapper(), /export PATH="\/opt\/redrob-vllm\/venv\/bin:/);
  assert.match(installScript(), /pip install -q ninja/);
});

test('the served endpoint is reachable off the host, the probe is not', () => {
  // There is no SSH forward any more: the workbench calls the GPU host, so the
  // unit has to answer on every interface. The measure probe is a throwaway
  // load nobody outside the host should reach, and stays on loopback.
  assert.match(serveWrapper(), /--host 0\.0\.0\.0/);
  assert.match(script, /--host 127\.0\.0\.1/);
});

test('start lays the wrapper down again instead of refusing a stale one', () => {
  // A host provisioned before the forward was removed has a wrapper that binds
  // loopback. Erroring out and asking for a re-run of Install only moved the
  // work, so start rewrites what it generated in the first place.
  const start = serviceControl('start', 0);
  const written = [...start.matchAll(/echo '([A-Za-z0-9+/=]+)' \| base64 -d/g)].map((m) =>
    Buffer.from(m[1]!, 'base64').toString('utf8'),
  );
  assert.ok(
    written.some((body) => body.includes('--host 0.0.0.0')),
    'start no longer refreshes the serve wrapper',
  );
  assert.match(start, /systemctl daemon-reload/);
});

test('probes run from a directory the service account can traverse', () => {
  // A login home is 0750, and vLLM resolves the model id against the cwd before
  // it asks the Hub, so an unreadable cwd reads as "Invalid repository ID".
  assert.match(script, /cd "\$\{PROBE_LOG_DIR\}"/);
});

test('probes get a writable home instead of inheriting root', () => {
  // sudo -E hands over HOME=/root, and vLLM caches under ~/.cache.
  assert.match(script, /SERVICE_HOME=/);
  assert.match(script, /HOME="\$\{SERVICE_HOME\}"/);
  assert.match(script, /XDG_CACHE_HOME="\$\{SERVICE_HOME\}\/\.cache"/);
});

test('waiting reports progress and gives up when the probe dies', () => {
  assert.match(script, /start_follow/);
  assert.match(script, /tail -n \+1 -F/);
  assert.match(script, /exited before it answered/);
});

test('every exit path releases the GPU and stops the log follower', () => {
  assert.match(script, /trap on_interrupt INT TERM/);
  assert.match(script, /trap stop_follow EXIT/);
});

test('a failure names the root cause, not just the outer traceback', () => {
  assert.match(script, /root cause candidates/);
});

test('no step that prints progress is called inside a command substitution', () => {
  // $(load ...) would capture stdout, and the pane showed nothing between the
  // opening banner and the final error for as long as that was how it worked.
  const code = activeLines(script).join('\n');
  for (const fn of ['load', 'start_probe', 'wait_ready']) {
    const captured = new RegExp(`\\$\\(\\s*${fn}\\b`);
    assert.ok(!captured.test(code), `${fn} output is captured instead of shown`);
  }
});
