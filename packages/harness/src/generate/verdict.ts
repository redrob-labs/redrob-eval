// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * Verdicts and the unsupported-verifier error, per spec section 6.
 *
 * `passed` and `code` are normative and are what the conformance suite compares.
 * `message` and `detail` are for humans and are deliberately not compared, so an
 * implementation can improve its diagnostics without breaking cross-language agreement.
 */
import { VERDICT_CODES, type VerdictCode } from './spec-types.generated';

export type { VerdictCode };
export { VERDICT_CODES };

export interface Verdict {
  passed: boolean;
  code: VerdictCode;
  message?: string;
  detail?: Record<string, unknown>;
}

export function ok(message?: string): Verdict {
  return message ? { passed: true, code: 'ok', message } : { passed: true, code: 'ok' };
}

export function fail(
  code: VerdictCode,
  message: string,
  detail?: Record<string, unknown>,
): Verdict {
  return detail ? { passed: false, code, message, detail } : { passed: false, code, message };
}

/**
 * Thrown when a verifier type cannot be evaluated here.
 *
 * This is an error rather than a skip on purpose. A skipped verifier reported as a
 * success is the worst failure mode this project has: it inflates a score silently and
 * the inflation is invisible in the output. Callers that want a verdict instead of an
 * exception get `{ passed: false, code: 'unsupported_verifier' }`, which still cannot
 * be counted as correct.
 */
export class UnsupportedVerifierError extends Error {
  readonly verifierType: string;

  readonly reason: string;

  constructor(verifierType: string, reason = '') {
    super(`unsupported verifier type ${JSON.stringify(verifierType)}${reason ? `: ${reason}` : ''}`);
    this.name = 'UnsupportedVerifierError';
    this.verifierType = verifierType;
    this.reason = reason;
  }
}

/** Thrown when a verifier's own configuration is invalid, as opposed to the candidate. */
export class VerifierConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerifierConfigError';
  }
}
