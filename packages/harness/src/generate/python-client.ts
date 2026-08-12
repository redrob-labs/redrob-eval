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

/**
 * Points the bridge at a specific executable, for the common case of an editable install
 * inside a virtualenv that is not on the server process's PATH.
 */
export const COMMAND_ENV_VAR = 'REDROB_GENERATE_CMD';

/**
 * Read at call time rather than at module load, because the repo-root `.env` is loaded by
 * the web app's config after this module is first imported.
 */
function resolveCommand(explicit?: string): string {
  if (explicit) return explicit;
  const fromEnv = process.env[COMMAND_ENV_VAR]?.trim();
  return fromEnv || DEFAULT_COMMAND;
}

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

/**
 * Machine-readable cause behind `reason`.
 *
 * `reason` is written for a log, in English. A UI that shows it to a reader needs to say
 * the same thing in the reader's language, which it can only do from a stable code.
 */
export type BridgeUnavailableCode =
  | 'not-found'
  | 'not-executable'
  | 'timed-out'
  | 'spawn-failed'
  | 'version-failed';

export interface BridgeUnavailable {
  available: false;
  reason: string;
  reasonCode?: BridgeUnavailableCode;
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
      reasonCode: 'not-found',
      reason:
        `'${command}' was not found on PATH. Generation is optional: install it with ` +
        '`pip install -e packages/generate`, or pass a command that points at your virtualenv.',
    };
  }
  if (error.code === 'EACCES') {
    return {
      available: false,
      reasonCode: 'not-executable',
      reason: `'${command}' is not executable.`,
      detail: error.message,
    };
  }
  if (error.code === 'ETIMEDOUT') {
    return { available: false, reasonCode: 'timed-out', reason: error.message };
  }
  return {
    available: false,
    reasonCode: 'spawn-failed',
    reason: `'${command}' could not be started.`,
    detail: error.message,
  };
}

/** Check whether the bridge is usable, without running a verification. */
export async function probePythonBridge(options: BridgeOptions = {}): Promise<
  | { available: true; version: string }
  | { available: false; reason: string; reasonCode: BridgeUnavailableCode; command: string }
> {
  const command = resolveCommand(options.command);
  try {
    const result = await run(command, [...(options.prefixArgs ?? []), '--version'], options);
    if (result.code !== 0) {
      return {
        available: false,
        reasonCode: 'version-failed',
        command,
        reason: `'${command} --version' exited with ${result.code}: ${result.stderr.trim()}`,
      };
    }
    return { available: true, version: result.stdout.trim() };
  } catch (error) {
    const outcome = describeSpawnFailure(command, error as NodeJS.ErrnoException);
    return {
      available: false,
      reason: outcome.reason,
      reasonCode: outcome.reasonCode ?? 'spawn-failed',
      command,
    };
  }
}

export interface EmitRequest {
  /** Template family directory, or a merged single-file template. */
  templatePath: string;
  count: number;
  /** Output directory. The caller owns it, including cleaning it up. */
  outDirectory: string;
  locale?: string;
  /** Pin the manifest timestamp so two emits of the same inputs match byte for byte. */
  createdAt?: string;
}

export type EmitOutcome =
  | { available: true; instances: unknown[]; manifest: unknown }
  | BridgeUnavailable;

/**
 * Run `redrob-generate emit` and read back what it wrote.
 *
 * Generation is Python-only by design — this implementation reads and verifies but does
 * not sample — so there is no TypeScript fallback to degrade to. A caller that cannot
 * reach the CLI gets `available: false` and should say so rather than showing an empty
 * result, which would look like a template with no instances.
 */
export async function emitWithPython(
  request: EmitRequest,
  options: BridgeOptions = {},
): Promise<EmitOutcome> {
  const command = resolveCommand(options.command);
  const args = [
    ...(options.prefixArgs ?? []),
    'emit',
    '--template',
    request.templatePath,
    '--count',
    String(request.count),
    '--out',
    request.outDirectory,
    '--quiet',
  ];
  if (request.locale) args.push('--locale', request.locale);
  if (request.createdAt) args.push('--created-at', request.createdAt);

  let result: RunResult;
  try {
    result = await run(command, args, options);
  } catch (error) {
    return describeSpawnFailure(command, error as NodeJS.ErrnoException);
  }
  if (result.code !== 0) {
    return {
      available: false,
      reason: `'${command} emit' exited with ${result.code}.`,
      detail: result.stderr.trim() || undefined,
    };
  }

  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  try {
    const [instancesText, manifestText] = await Promise.all([
      readFile(join(request.outDirectory, 'instances.jsonl'), 'utf8'),
      readFile(join(request.outDirectory, 'manifest.json'), 'utf8'),
    ]);
    const instances = instancesText
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as unknown);
    return { available: true, instances, manifest: JSON.parse(manifestText) as unknown };
  } catch (error) {
    return {
      available: false,
      reason: `'${command} emit' reported success but wrote nothing readable.`,
      detail: (error as Error).message,
    };
  }
}

export interface StudyRequest {
  /** Study config JSON. */
  configPath: string;
  outDirectory: string;
  createdAt?: string;
  /** Refuse to finish unless the artifact may be published. */
  publish?: boolean;
}

export type StudyOutcome =
  | { available: true; result: unknown; table: string; publishable: boolean; refusal?: string }
  | BridgeUnavailable;

/**
 * Run `redrob-generate study` and read back the artifact and the table.
 *
 * Exit 3 is the publication refusal, which is a result rather than a bridge failure: the
 * artifact was written, and the reason it may not be published is the thing worth
 * showing. Only a missing or unreadable artifact is a failure of the bridge.
 */
export async function studyWithPython(
  request: StudyRequest,
  options: BridgeOptions = {},
): Promise<StudyOutcome> {
  const command = resolveCommand(options.command);
  const args = [
    ...(options.prefixArgs ?? []),
    'study',
    '--config',
    request.configPath,
    '--out',
    request.outDirectory,
    '--quiet',
  ];
  if (request.createdAt) args.push('--created-at', request.createdAt);
  if (request.publish) args.push('--publish');

  let result: RunResult;
  try {
    result = await run(command, args, options);
  } catch (error) {
    return describeSpawnFailure(command, error as NodeJS.ErrnoException);
  }
  if (result.code !== 0 && result.code !== 3) {
    return {
      available: false,
      reason: `'${command} study' exited with ${result.code}.`,
      detail: result.stderr.trim() || undefined,
    };
  }

  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  try {
    const [resultText, tableText] = await Promise.all([
      readFile(join(request.outDirectory, 'result.json'), 'utf8'),
      readFile(join(request.outDirectory, 'aggregates.txt'), 'utf8'),
    ]);
    return {
      available: true,
      result: JSON.parse(resultText) as unknown,
      table: tableText,
      publishable: result.code === 0,
      refusal: result.code === 3 ? result.stderr.trim() : undefined,
    };
  } catch (error) {
    return {
      available: false,
      reason: `'${command} study' reported success but wrote nothing readable.`,
      detail: (error as Error).message,
    };
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
  const command = resolveCommand(options.command);
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
