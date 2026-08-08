// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * Who produced a verdict, and whether it may be published.
 *
 * This implementation agrees with the Python one on every row of the conformance
 * corpus, and that is checked on every build. It is still not a reason to treat the two
 * as interchangeable when a result is going to be published, because they read
 * different Unicode tables: this runtime's ICU and CPython's `unicodedata` are compiled
 * against different versions of the Unicode Character Database, so a normalisation or a
 * case mapping over a code point assigned between those versions can differ while both
 * implementations behave correctly.
 *
 * So Python is normative and this side is display only. Every verdict record produced
 * here says so in the record itself, and a publishable artifact refuses to build from
 * one. Nothing here is disabled — verify whatever you like, the label travels with it.
 */

/** The implementation this module is. Recorded verbatim in verdict records it produces. */
export const IMPLEMENTATION = "@redrob/harness";

/**
 * Unicode version this runtime's ICU implements. Read from `process.versions` rather
 * than pinned, because a pinned value would record a claim instead of a measurement.
 * Falls back to `unknown` on a build without full ICU, which is itself worth recording.
 */
export const UNICODE_VERSION: string = process.versions.unicode ?? "unknown";

export interface Provenance {
  implementation: string;
  implementation_version: string;
  unicode_version: string;
  authoritative: boolean;
}

/**
 * The provenance block for a verdict this runtime produced.
 *
 * `authoritative` is hard-coded false and takes no argument. Making it a parameter
 * would make "publish a TypeScript verdict" reachable by passing a flag, and the point
 * of the policy is that it is not reachable at all from this side.
 */
export function localProvenance(version: string): Provenance {
  return {
    implementation: IMPLEMENTATION,
    implementation_version: version,
    unicode_version: UNICODE_VERSION,
    authoritative: false,
  };
}

/**
 * Whether a provenance block marks its verdict publishable.
 *
 * A missing block is not authoritative. Absence fails closed because a record written
 * before this field existed, or by a tool that does not know about it, is exactly the
 * case where the origin is unknown.
 */
export function isAuthoritative(provenance: unknown): boolean {
  if (typeof provenance !== "object" || provenance === null) return false;
  return (provenance as { authoritative?: unknown }).authoritative === true;
}
