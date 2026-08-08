// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * Canonical JSON and content hashing, per spec section 9.1.
 *
 * The number formatting is free here, because ECMAScript's `Number::toString` *is* the
 * normative algorithm; it is the Python side that has to reimplement it. What is not
 * free is key ordering: the default sort compares UTF-16 code units and the spec says
 * code points.
 */
import { createHash } from 'node:crypto';

import { compareByCodePoint } from './text';

/**
 * Beyond this an integer is not representable as a double.
 *
 * The spec bans integers outside this range, but the ban can only be enforced where the
 * distinction still exists. Python has arbitrary-precision integers and rejects them on
 * the way in; here every number is already a double, so an oversized integer literal was
 * rounded by `JSON.parse` before this module ever saw it. Use this to check a document at
 * the point it is parsed, not at the point it is serialised.
 */
export const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

function numberToString(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalJsonError(`${path}: non-finite number cannot be canonicalised`);
  }
  // No safe-integer check here on purpose: `1e21` is a JSON number that Python reads as a
  // float and canonicalises as `1e+21`, and rejecting it on this side would be a
  // divergence rather than a safety net. See MAX_SAFE_INTEGER.
  return Object.is(value, -0) ? '0' : String(value);
}

function serialise(value: unknown, path: string, out: string[]): void {
  if (value === null) {
    out.push('null');
    return;
  }
  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'number':
      out.push(numberToString(value, path));
      return;
    case 'string':
      out.push(JSON.stringify(value));
      return;
    case 'object':
      break;
    default:
      throw new CanonicalJsonError(`${path}: value of type ${typeof value} is not JSON`);
  }

  if (Array.isArray(value)) {
    out.push('[');
    value.forEach((item, index) => {
      if (index) out.push(',');
      serialise(item, `${path}[${index}]`, out);
    });
    out.push(']');
    return;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareByCodePoint);
  out.push('{');
  keys.forEach((key, index) => {
    if (index) out.push(',');
    out.push(JSON.stringify(key));
    out.push(':');
    serialise(record[key], `${path}.${key}`, out);
  });
  out.push('}');
}

/** Serialise a value to the canonical form defined by the spec. */
export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  serialise(value, '$', out);
  return out.join('');
}

/** `sha256:` plus the lowercase hex digest of the canonical JSON of a value. */
export function contentHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}
