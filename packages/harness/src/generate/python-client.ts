// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * Subprocess client for `redrob-generate verify`, per spec section 7.
 *
 * The CLI is the only bridge boundary: a subprocess exchanging JSON, with no HTTP
 * service and no other IPC mechanism. Every extra channel is another place the two
 * implementations can drift, and a subprocess needs no port, no auth and no lifecycle.
 *
 * Absence of Python is an expected state, not an error. Generation is optional and the
 * workbench installs and runs without it, so every entry point here reports
 * `available: false` with a message a human can act on rather than throwing.
 */
import { spawn } from 'node:child_process';

import type { VerdictCode } from './verdict';

export const DEFAULT_COMMAND = 'redrob-generate';
export const DEFAULT_TIMEOUT_MS = 120_000;

export interface BridgeOptions {
  /** Executable to run. Override to point at a virtualenv. */
  command?: string;
  /** Extra arguments inserted before the subcommand, e.g. `['-m', 'redrob_generate']`. */
  prefixArgs?: string[];
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface BridgeItemResult {
  instance_index: number;
  template_id: string;
  verifier_type: string;
  passed: boolean;
  code: VerdictCode;
  message?: string;
  detail?: Record<string, unknown>;
}

export interface BridgePayload {
  spec_version: string;
  generator_name: string;
  generator_version: string;
  set: string;
  instance_count: number;
  passed_count: number;
  results: BridgeItemResult[];
}

export interface BridgeUnavailable {
  available: false;
  reason: string;
  detail?: string;
}

export type BridgeOutcome = { available: true; payload: BridgePayload } | BridgeUnavailable;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], options: BridgeOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(
        Object.assign(new Error(`${command} did not finish within ${options.timeoutMs}ms`), {
          code: 'ETIMEDOUT',
        }),
      );
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function describeSpawnFailure(command: string, error: NodeJS.ErrnoException): BridgeUnavailable {
  if (error.code === 'ENOENT') {
    return {
      available: false,
      reason:
        `'${command}' was not found on PATH. Generation is optional: install it with ` +
        '`pip install -e packages/generate`, or pass a command that points at your virtualenv.',
    };
  }
  if (error.code === 'EACCES') {
    return { available: false, reason: `'${command}' is not executable.`, detail: error.message };
  }
  if (error.code === 'ETIMEDOUT') {
    return { available: false, reason: error.message };
  }
  return {
    available: false,
    reason: `'${command}' could not be started.`,
    detail: error.message,
  };
}

/** Check whether the bridge is usable, without running a verification. */
export async function probePythonBridge(
  options: BridgeOptions = {},
): Promise<{ available: true; version: string } | { available: false; reason: string }> {
  const command = options.command ?? DEFAULT_COMMAND;
  try {
    const result = await run(command, [...(options.prefixArgs ?? []), '--version'], options);
    if (result.code !== 0) {
      return {
        available: false,
        reason: `'${command} --version' exited with ${result.code}: ${result.stderr.trim()}`,
      };
    }
    return { available: true, version: result.stdout.trim() };
  } catch (error) {
    const outcome = describeSpawnFailure(command, error as NodeJS.ErrnoException);
    return { available: false, reason: outcome.reason };
  }
}

export interface VerifyRequest {
  /** Directory written by `redrob-generate emit`. */
  setDirectory: string;
  /** Path to a model outputs file, in any form the CLI accepts. */
  outputsPath: string;
  /** Refuse executable verifiers instead of running model-derived code. */
  allowExecutable?: boolean;
}

/**
 * Run `redrob-generate verify` and parse its JSON.
 *
 * A non-zero exit code is normal here: the CLI exits 1 when any item fails, which is a
 * result rather than an error. Only a missing or unparseable payload is a failure of
 * the bridge itself.
 */
export async function verifyWithPython(
  request: VerifyRequest,
  options: BridgeOptions = {},
): Promise<BridgeOutcome> {
  const command = options.command ?? DEFAULT_COMMAND;
  const args = [
    ...(options.prefixArgs ?? []),
    'verify',
    '--set',
    request.setDirectory,
    '--outputs',
    request.outputsPath,
    '--json',
  ];
  if (request.allowExecutable === false) args.push('--no-executable');

  let result: RunResult;
  try {
    result = await run(command, args, options);
  } catch (error) {
    return describeSpawnFailure(command, error as NodeJS.ErrnoException);
  }

  const stdout = result.stdout.trim();
  if (stdout === '') {
    return {
      available: false,
      reason: `'${command} verify' produced no output (exit ${result.code}).`,
      detail: result.stderr.trim() || undefined,
    };
  }
  try {
    return { available: true, payload: JSON.parse(stdout) as BridgePayload };
  } catch (error) {
    return {
      available: false,
      reason: `'${command} verify' produced output that is not JSON.`,
      detail: `${(error as Error).message}: ${stdout.slice(0, 400)}`,
    };
  }
}
