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
import { requireWellFormed } from './text';
import { fail, UnsupportedVerifierError, type Verdict } from './verdict';
import {
  DECLARATIVE_VERIFIERS,
  DECLARATIVE_VERIFIER_TYPES,
  EXECUTABLE_VERIFIER_TYPES,
} from './verifiers';

export type ExecutableVerifierType = (typeof EXECUTABLE_VERIFIER_TYPES)[number];

export { DECLARATIVE_VERIFIER_TYPES, EXECUTABLE_VERIFIER_TYPES };

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
 * Run every verifier in a list against the same candidate. All must pass.
 *
 * **Every element runs, always.** There is no short circuit, and that is the whole of
 * what makes the per-element report meaningful: a caller gets a verdict for each element
 * rather than a verdict for the first one that happened to fail plus silence about the
 * rest. It also removes a failure mode the composite this replaces had, where an element
 * with an unusable configuration was never reached because an earlier element failed
 * first, so a template that could not be scored looked like an answer that was wrong.
 *
 * The overall `code` is the first failing element's, verbatim, so ordering the elements
 * still chooses which diagnosis leads. `detail.elements` carries all of them.
 *
 * Elements must be declarative. That is enforced by the schema — a verifier list
 * references the declarative union, so an executable element is a load-time violation —
 * and again here, because this function is reachable without a schema check.
 */
export function runVerifierList(verifiers: readonly Verifier[], candidate: string): Verdict {
  const elements: Array<{ index: number; type: string; passed: boolean; code: string }> = [];
  let firstFailure: Verdict | undefined;
  verifiers.forEach((element, index) => {
    const elementType = (element as { type?: unknown } | null)?.type;
    if (typeof elementType !== 'string' || !isDeclarative(elementType)) {
      throw new UnsupportedVerifierError(
        String(elementType),
        `verifier[${index}] is not a declarative verifier; a verifier list may only contain ` +
          'types every implementation evaluates identically',
      );
    }
    const verdict = runVerifier(element, candidate);
    elements.push({
      index,
      type: elementType,
      passed: verdict.passed,
      code: verdict.code,
    });
    if (!verdict.passed && firstFailure === undefined) firstFailure = verdict;
  });
  if (firstFailure === undefined) {
    return {
      passed: true,
      code: 'ok',
      message: `all ${elements.length} verifiers passed`,
      detail: { elements },
    };
  }
  return {
    passed: false,
    code: firstFailure.code,
    message: firstFailure.message,
    detail: { ...firstFailure.detail, elements },
  };
}

/**
 * Run a verifier field against one candidate output.
 *
 * `verifier` is either one verifier object or a list of declarative verifiers, all of
 * which must pass; see {@link runVerifierList}.
 *
 * Throws {@link UnsupportedVerifierError} for the executable tier and for any unknown
 * type. Use {@link runVerifierOrFail} when a verdict is wanted instead of an exception.
 */
export function runVerifier(verifier: Verifier | readonly Verifier[], candidate: string): Verdict {
  if (Array.isArray(verifier)) {
    return runVerifierList(verifier, candidate);
  }
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
  // Checked here rather than in each verifier, so a field added later inherits the rule.
  requireWellFormed(verifier, `the ${verifierType} verifier's configuration`);
  return handler(verifier as never, candidate);
}

/**
 * The same dispatch, but an unsupported type becomes an explicit failing verdict.
 *
 * Still a failure, never a pass and never a silent omission, so an item scored this way
 * cannot be counted as correct by mistake.
 */
export function runVerifierOrFail(
  verifier: Verifier | readonly Verifier[],
  candidate: string,
): Verdict {
  try {
    return runVerifier(verifier, candidate);
  } catch (error) {
    if (error instanceof UnsupportedVerifierError) {
      return fail('unsupported_verifier', error.message, { verifier_type: error.verifierType });
    }
    throw error;
  }
}
