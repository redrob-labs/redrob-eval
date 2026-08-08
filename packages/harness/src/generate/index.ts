// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * TypeScript implementation of the Redrob Verifiable Task Spec v1
 * (`spec/verifiable-task-v1.md`).
 *
 * This is a peer of the Python implementation under `packages/generate/`, not a client
 * of it: neither is authoritative over the other, and `spec/conformance/` decides when
 * they disagree. What differs is capability, not rank. This side reads generated sets,
 * audits their seeds and template hashes, and runs every declarative verifier natively.
 * It does not generate, and it refuses the executable tier with an explicit error rather
 * than skipping it.
 *
 * Not wired into any route or UI. Imported as `@redrob/harness/generate`.
 */
export {
  canonicalJson,
  contentHash,
  CanonicalJsonError,
  MAX_SAFE_INTEGER,
} from './canonical';

export {
  jsonDeepEqual,
  validateInstance,
  validateSchemaDocument,
  SchemaSubsetError,
  SUPPORTED_KEYWORDS,
  REJECTED_KEYWORDS,
  type Schema,
  type SchemaViolation,
} from './json-schema-subset';

export {
  DEFAULT_COMMAND,
  DEFAULT_TIMEOUT_MS,
  probePythonBridge,
  verifyWithPython,
  type BridgeItemResult,
  type BridgeOptions,
  type BridgeOutcome,
  type BridgePayload,
  type VerifyRequest,
} from './python-client';

export {
  auditManifestConsistency,
  auditSeeds,
  auditTemplateHash,
  GeneratedSetError,
  INSTANCES_FILENAME,
  LOCALE_ONLY_FIELDS,
  MANIFEST_FILENAME,
  mergeTemplateLayers,
  parseInstances,
  readGeneratedSet,
  readTemplate,
  SPEC_VERSION,
  type GeneratedSet,
  type SeedAudit,
  type SeedAuditEntry,
  type TemplateHashAudit,
} from './reader';

export {
  compileSubsetPattern,
  RegexSubsetError,
  rewrite as rewriteRegexPattern,
  scan as scanRegexPattern,
  validate as validateRegexPattern,
  type Token as RegexToken,
} from './regex-subset';

export {
  ALL_VERIFIER_TYPES,
  DECLARATIVE_VERIFIER_TYPES,
  EXECUTABLE_VERIFIER_TYPES,
  isDeclarative,
  isExecutable,
  runVerifier,
  runVerifierOrFail,
  type ExecutableVerifierType,
} from './registry';

export { deriveSeed, SEED_METHOD, seedMessage, seedToString } from './seed';

export {
  applyUnicodeNormalization,
  codePointLength,
  collapseSpecWhitespace,
  compareByCodePoint,
  countLines,
  isSpecWhitespace,
  normalizeLineEndings,
  SPEC_WHITESPACE,
  stripSpecWhitespace,
  type UnicodeNormalization,
} from './text';

export {
  fail,
  ok,
  UnsupportedVerifierError,
  VERDICT_CODES,
  VerifierConfigError,
  type Verdict,
  type VerdictCode,
} from './verdict';

export {
  assertAllOfIsDeclarative,
  coerceExpectedNumber,
  compareNumbers,
  DECLARATIVE_VERIFIERS,
  MAX_ALL_OF_DEPTH,
  parseSpecNumber,
  verifyAllOf,
  verifyExact,
  verifyFormatConstraint,
  verifyJsonSchema,
  verifyNumericTolerance,
  verifyOrderedEquality,
  verifyRegex,
  verifySetEquality,
} from './verifiers';

export type {
  AllOfVerifier,
  ConformanceCase,
  ConformanceFile,
  ConformanceRejection,
  DeclarativeVerifier,
  ElementParse,
  ExactVerifier,
  Fertility,
  FormatConstraintVerifier,
  Instance,
  JsonSchemaVerifier,
  Manifest,
  ManifestCitation,
  ManifestFertility,
  ManifestTemplateEntry,
  NumericToleranceVerifier,
  OrderedEqualityVerifier,
  Parameter,
  RegexVerifier,
  SetEqualityVerifier,
  Template,
  Verifier,
} from './spec-types.generated';
