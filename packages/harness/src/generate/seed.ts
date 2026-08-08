// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * Seed derivation, per spec section 2.
 *
 * TypeScript never generates, so this exists to *audit*: given a published set, anyone
 * can recompute the seed of every instance from the generator version and template id
 * and check it against what the file claims. That check is the mechanism that makes
 * cherry-picking detectable rather than merely discouraged.
 */
import { createHash } from 'node:crypto';

export const SEED_METHOD = 'sha256-prefix-uint64-be';

const SEPARATOR = Buffer.from([0x00]);

/** The exact byte string that gets hashed. Exposed so a mismatch can be debugged. */
export function seedMessage(
  generatorVersion: string,
  templateId: string,
  instanceIndex: number,
): Buffer {
  if (!Number.isInteger(instanceIndex) || instanceIndex < 0) {
    throw new RangeError(`instanceIndex must be a non-negative integer, got ${instanceIndex}`);
  }
  return Buffer.concat([
    Buffer.from(generatorVersion, 'utf8'),
    SEPARATOR,
    Buffer.from(templateId, 'utf8'),
    SEPARATOR,
    Buffer.from(String(instanceIndex), 'utf8'),
  ]);
}

/**
 * The uint64 seed, as a bigint.
 *
 * A bigint rather than a number because a uint64 does not fit in a double; returning a
 * number here would silently round and every audit would produce a near miss.
 */
export function deriveSeed(
  templateId: string,
  instanceIndex: number,
  generatorVersion: string,
): bigint {
  const digest = createHash('sha256')
    .update(seedMessage(generatorVersion, templateId, instanceIndex))
    .digest();
  return digest.readBigUInt64BE(0);
}

/** Seeds travel in JSON as decimal strings, for the same reason. */
export function seedToString(seed: bigint): string {
  return seed.toString(10);
}
