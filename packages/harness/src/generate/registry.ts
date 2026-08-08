// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * Verifier dispatch, per spec section 6.2.
 *
 * The executable tier is Python only. This implementation raises
 * {@link UnsupportedVerifierError} for those types rather than skipping them, because a
 * skipped verifier reported as a success silently inflates every score computed from
 * it, and the inflation is invisible in the output. There is no configuration flag that
 * turns a `sympy_equiv` item into a pass here; the only ways forward are the Python
 * bridge or an explicit failure.
 */
import type { Verifier } from './spec-types.generated';
import { fail, UnsupportedVerifierError, type Verdict } from './verdict';
import { DECLARATIVE_VERIFIERS, DECLARATIVE_VERIFIER_TYPES } from './verifiers';

export const EXECUTABLE_VERIFIER_TYPES = ['sympy_equiv', 'python_unittest'] as const;

export type ExecutableVerifierType = (typeof EXECUTABLE_VERIFIER_TYPES)[number];

export { DECLARATIVE_VERIFIER_TYPES };

export const ALL_VERIFIER_TYPES = [
  ...DECLARATIVE_VERIFIER_TYPES,
  ...EXECUTABLE_VERIFIER_TYPES,
];

export function isDeclarative(verifierType: string): boolean {
  return verifierType in DECLARATIVE_VERIFIERS;
}

export function isExecutable(verifierType: string): verifierType is ExecutableVerifierType {
  return (EXECUTABLE_VERIFIER_TYPES as readonly string[]).includes(verifierType);
}

/**
 * Run a declarative verifier.
 *
 * Throws {@link UnsupportedVerifierError} for the executable tier and for any unknown
 * type. Use {@link runVerifierOrFail} when a verdict is wanted instead of an exception.
 */
export function runVerifier(verifier: Verifier, candidate: string): Verdict {
  const verifierType = (verifier as { type?: unknown }).type;
  if (typeof verifierType !== 'string') {
    throw new UnsupportedVerifierError(String(verifierType), 'the verifier has no type tag');
  }
  if (isExecutable(verifierType)) {
    throw new UnsupportedVerifierError(
      verifierType,
      'executable verifiers run in Python only; use the redrob-generate verify bridge',
    );
  }
  const handler = DECLARATIVE_VERIFIERS[verifierType];
  if (!handler) {
    throw new UnsupportedVerifierError(verifierType, 'no implementation is registered');
  }
  return handler(verifier as never, candidate);
}

/**
 * The same dispatch, but an unsupported type becomes an explicit failing verdict.
 *
 * Still a failure, never a pass and never a silent omission, so an item scored this way
 * cannot be counted as correct by mistake.
 */
export function runVerifierOrFail(verifier: Verifier, candidate: string): Verdict {
  try {
    return runVerifier(verifier, candidate);
  } catch (error) {
    if (error instanceof UnsupportedVerifierError) {
      return fail('unsupported_verifier', error.message, { verifier_type: error.verifierType });
    }
    throw error;
  }
}
