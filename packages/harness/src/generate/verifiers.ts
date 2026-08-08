// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * The seven declarative verifiers, per spec section 6.1.
 *
 * These must produce identical verdicts to the Python implementation, down to the
 * verdict code. `spec/conformance/` is what proves it; this module is one of the two
 * things being proved. Read it next to
 * packages/generate/src/redrob_generate/verify/declarative.py.
 */
import { canonicalJson } from './canonical';
import {
  jsonDeepEqual,
  validateInstance,
  validateSchemaDocument,
  SchemaSubsetError,
  type Schema,
} from './json-schema-subset';
import { compileSubsetPattern, RegexSubsetError, validateFlags } from './regex-subset';
import type {
  ElementParse,
  ExactVerifier,
  FormatConstraintVerifier,
  JsonSchemaVerifier,
  NumericToleranceVerifier,
  OrderedEqualityVerifier,
  RegexVerifier,
  SetEqualityVerifier,
} from './spec-types.generated';
import {
  applyUnicodeNormalization,
  collapseSpecWhitespace,
  countLines,
  DEFAULT_NORMALIZATION,
  measureLength,
  normalizeJsonStrings,
  normalizeLineEndings,
  stripSpecWhitespace,
  type UnicodeNormalization,
} from './text';
import { fail, ok, VerifierConfigError, type Verdict } from './verdict';

// ------------------------------------------------------------------- numbers

/**
 * The spec number grammar. Deliberately narrower than `Number()`, which accepts hex,
 * empty strings and whitespace-only input, and narrower than Python's `float()`, which
 * accepts underscores.
 */
const SPEC_NUMBER =
  /^[+-]?(?:nan|inf|infinity|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)$/i;

export interface ParseNumberOptions {
  trim?: boolean;
  allowThousandsSeparator?: boolean;
}

/** Parse a candidate under the spec grammar. `null` means it is not a number. */
export function parseSpecNumber(text: string, options: ParseNumberOptions = {}): number | null {
  const { trim = true, allowThousandsSeparator = false } = options;
  let value = trim ? stripSpecWhitespace(text) : text;
  if (allowThousandsSeparator) value = value.replace(/,/g, '');
  if (!SPEC_NUMBER.test(value)) return null;

  const negative = value.startsWith('-');
  const body = value.replace(/^[+-]/, '').toLowerCase();
  if (body === 'nan') return Number.NaN;
  if (body === 'inf' || body === 'infinity') {
    return negative ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }
  return Number(value);
}

export function coerceExpectedNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value === 'NaN') return Number.NaN;
  if (value === 'Infinity') return Number.POSITIVE_INFINITY;
  if (value === '-Infinity') return Number.NEGATIVE_INFINITY;
  throw new VerifierConfigError(`${JSON.stringify(value)} is not a valid numeric expectation`);
}

export interface CompareNumbersOptions {
  absTol?: number;
  relTol?: number;
  nanMatchesNan?: boolean;
}

export function compareNumbers(
  candidate: number,
  expected: number,
  options: CompareNumbersOptions = {},
): Verdict {
  const { absTol = 0, relTol = 0, nanMatchesNan = false } = options;

  if (Number.isNaN(candidate) || Number.isNaN(expected)) {
    if (Number.isNaN(candidate) && Number.isNaN(expected) && nanMatchesNan) {
      return ok('both values are NaN and nan_matches_nan is set');
    }
    return fail('nan_mismatch', 'NaN was involved and did not satisfy the configured NaN policy');
  }
  const candidateInfinite = !Number.isFinite(candidate);
  const expectedInfinite = !Number.isFinite(expected);
  if (candidateInfinite || expectedInfinite) {
    if (candidateInfinite && expectedInfinite && Math.sign(candidate) === Math.sign(expected)) {
      return ok('both values are the same signed infinity');
    }
    return fail('infinity_mismatch', 'one side is infinite and the other does not match it');
  }

  const tolerance = Math.max(absTol, relTol * Math.abs(expected));
  const difference = Math.abs(candidate - expected);
  if (difference <= tolerance) return ok();
  return fail('out_of_tolerance', `difference ${difference} exceeds tolerance ${tolerance}`, {
    candidate,
    expected,
    difference,
    tolerance,
  });
}

// --------------------------------------------------------------------- exact

export function verifyExact(config: ExactVerifier, candidate: string): Verdict {
  const normalize = (text: string): string => {
    let out = applyUnicodeNormalization(
      text,
      (config.normalization ?? DEFAULT_NORMALIZATION) as UnicodeNormalization,
    );
    if (config.normalize_line_endings === true) out = normalizeLineEndings(out);
    if (config.trim === true) out = stripSpecWhitespace(out);
    if (config.collapse_whitespace === true) out = collapseSpecWhitespace(out);
    if (config.case_sensitive === false) out = out.toLowerCase();
    return out;
  };

  return normalize(candidate) === normalize(config.expected)
    ? ok()
    : fail('mismatch', 'normalised candidate does not equal the normalised expectation');
}

// --------------------------------------------------------- numeric_tolerance

export function verifyNumericTolerance(
  config: NumericToleranceVerifier,
  candidate: string,
): Verdict {
  const parsed = parseSpecNumber(candidate, {
    trim: config.trim ?? true,
    allowThousandsSeparator: config.allow_thousands_separator ?? false,
  });
  if (parsed === null) {
    return fail('not_a_number', 'candidate is not a single number under the spec grammar');
  }
  return compareNumbers(parsed, coerceExpectedNumber(config.expected), {
    absTol: config.abs_tol ?? 0,
    relTol: config.rel_tol ?? 0,
    nanMatchesNan: config.nan_matches_nan ?? false,
  });
}

// ------------------------------------------------------------- json_schema

export function verifyJsonSchema(config: JsonSchemaVerifier, candidate: string): Verdict {
  const schema = config.schema as Schema;
  const form = (config.normalization ?? DEFAULT_NORMALIZATION) as UnicodeNormalization;
  try {
    validateSchemaDocument(schema, '#', 0, form);
  } catch (error) {
    if (error instanceof SchemaSubsetError) {
      throw new VerifierConfigError(`schema is outside the supported subset: ${error.message}`);
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return fail('invalid_json', 'candidate is not well-formed JSON');
  }
  parsed = normalizeJsonStrings(parsed, form);

  const violations = validateInstance(schema, parsed);
  if (violations.length === 0) return ok();
  const first = violations[0] as { pointer: string; message: string };
  return fail('schema_violation', `${first.pointer}: ${first.message}`, {
    pointer: first.pointer,
    violations: violations.length,
  });
}

// --------------------------------------------------------------------- regex

export function verifyRegex(config: RegexVerifier, candidate: string): Verdict {
  const mode = config.mode ?? 'full_match';
  let compiled;
  try {
    // The subset has no flags, so a config carrying one is refused rather than ignored.
    validateFlags((config as { flags?: readonly string[] }).flags ?? []);
    compiled = compileSubsetPattern(config.pattern, mode);
  } catch (error) {
    if (error instanceof RegexSubsetError) return fail('invalid_pattern', error.message);
    throw error;
  }
  if (compiled.regexp.test(candidate)) return ok();
  return fail('no_match', `pattern did not ${mode.replace('_', ' ')} the candidate`);
}

// -------------------------------------------------- set and ordered equality

function splitElements(
  parse: ElementParse,
  candidate: string,
  form: UnicodeNormalization,
): unknown[] | null {
  let elements: unknown[];
  switch (parse.mode) {
    case 'json_array': {
      let parsed: unknown;
      try {
        parsed = JSON.parse(candidate);
      } catch {
        return null;
      }
      if (!Array.isArray(parsed)) return null;
      elements = parsed;
      break;
    }
    case 'lines':
      elements = normalizeLineEndings(candidate).split('\n');
      break;
    case 'delimiter':
      elements = candidate.split(parse.delimiter ?? ',');
      break;
    default:
      throw new VerifierConfigError(`unknown parse mode ${JSON.stringify(parse.mode)}`);
  }

  // Normalisation runs on the split elements rather than on the raw candidate, because
  // for json_array the raw candidate may spell a character as a \uXXXX escape, which is
  // ASCII and so survives normalisation untouched.
  elements = elements.map((element) => normalizeJsonStrings(element, form));

  if (parse.trim_elements ?? true) {
    elements = elements.map((element) =>
      typeof element === 'string' ? stripSpecWhitespace(element) : element,
    );
  }
  if (parse.drop_empty ?? true) {
    elements = elements.filter((element) => element !== '');
  }
  return elements;
}

type ElementComparator = 'exact_string' | 'case_insensitive_string' | 'numeric' | 'json';

/**
 * A string identity used only for deduplication, never for tolerance matching.
 *
 * A string rather than a structured key because NaN is not equal to itself, so a
 * structured key holding one would deduplicate by object identity.
 */
function canonicalKey(value: unknown, comparator: ElementComparator): string {
  if (comparator === 'case_insensitive_string') return `ci:${String(value).toLowerCase()}`;
  if (comparator === 'numeric') {
    const parsed = typeof value === 'number' ? value : parseSpecNumber(String(value));
    if (parsed === null) return `raw:${String(value)}`;
    if (Number.isNaN(parsed)) return 'num:NaN';
    if (!Number.isFinite(parsed)) return parsed > 0 ? 'num:Infinity' : 'num:-Infinity';
    return `num:${canonicalJson(parsed)}`;
  }
  if (comparator === 'json') return `json:${canonicalJson(value)}`;
  return `str:${String(value)}`;
}

function dedupe(values: readonly unknown[], comparator: ElementComparator): unknown[] {
  const seen = new Set<string>();
  const result: unknown[] = [];
  for (const value of values) {
    const key = canonicalKey(value, comparator);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function elementsEqual(
  candidate: unknown,
  expected: unknown,
  comparator: ElementComparator,
  absTol: number,
  relTol: number,
): boolean {
  switch (comparator) {
    case 'exact_string':
      return String(candidate) === String(expected);
    case 'case_insensitive_string':
      return String(candidate).toLowerCase() === String(expected).toLowerCase();
    case 'json':
      return jsonDeepEqual(candidate, expected);
    case 'numeric': {
      const left = typeof candidate === 'number' ? candidate : parseSpecNumber(String(candidate));
      const right = typeof expected === 'number' ? expected : parseSpecNumber(String(expected));
      if (left === null || right === null) return false;
      return compareNumbers(left, right, { absTol, relTol }).passed;
    }
    default:
      throw new VerifierConfigError(`unknown element comparator ${String(comparator)}`);
  }
}

export function verifySetEquality(config: SetEqualityVerifier, candidate: string): Verdict {
  const form = (config.normalization ?? DEFAULT_NORMALIZATION) as UnicodeNormalization;
  let elements = splitElements(config.parse, candidate, form);
  if (elements === null) return fail('parse_error', 'candidate could not be split into elements');

  const comparator = (config.element_comparator ?? 'exact_string') as ElementComparator;
  const absTol = config.numeric_abs_tol ?? 0;
  const relTol = config.numeric_rel_tol ?? 0;
  let expected: unknown[] = config.expected.map((value) => normalizeJsonStrings(value, form));

  if ((config.duplicates ?? 'collapse') === 'collapse') {
    elements = dedupe(elements, comparator);
    expected = dedupe(expected, comparator);
  }

  if (elements.length !== expected.length) {
    return fail(
      'cardinality_mismatch',
      `expected ${expected.length} elements, candidate has ${elements.length}`,
      { expected_count: expected.length, candidate_count: elements.length },
    );
  }

  const remaining = [...elements];
  for (const wanted of expected) {
    const index = remaining.findIndex((actual) =>
      elementsEqual(actual, wanted, comparator, absTol, relTol),
    );
    if (index === -1) {
      return fail('element_mismatch', `no candidate element matches ${JSON.stringify(wanted)}`);
    }
    remaining.splice(index, 1);
  }
  return ok();
}

export function verifyOrderedEquality(config: OrderedEqualityVerifier, candidate: string): Verdict {
  const form = (config.normalization ?? DEFAULT_NORMALIZATION) as UnicodeNormalization;
  const elements = splitElements(config.parse, candidate, form);
  if (elements === null) return fail('parse_error', 'candidate could not be split into elements');

  const comparator = (config.element_comparator ?? 'exact_string') as ElementComparator;
  const absTol = config.numeric_abs_tol ?? 0;
  const relTol = config.numeric_rel_tol ?? 0;
  const expected = config.expected.map((value) => normalizeJsonStrings(value, form));

  if (elements.length !== expected.length) {
    return fail(
      'cardinality_mismatch',
      `expected ${expected.length} elements, candidate has ${elements.length}`,
      { expected_count: expected.length, candidate_count: elements.length },
    );
  }
  for (let position = 0; position < expected.length; position += 1) {
    if (!elementsEqual(elements[position], expected[position], comparator, absTol, relTol)) {
      return fail(
        'element_mismatch',
        `element ${position} does not match ${JSON.stringify(expected[position])}`,
        { position },
      );
    }
  }
  return ok();
}

// ---------------------------------------------------------- format_constraint

export function verifyFormatConstraint(
  config: FormatConstraintVerifier,
  candidate: string,
): Verdict {
  const form = (config.normalization ?? DEFAULT_NORMALIZATION) as UnicodeNormalization;
  const unit = config.length_unit ?? 'codepoints';

  let text = applyUnicodeNormalization(candidate, form);
  if (config.normalize_line_endings ?? true) text = normalizeLineEndings(text);
  if (config.trim === true) text = stripSpecWhitespace(text);

  // Measured after normalisation, and it matters: NFC turns "cafe\u0301" from six code
  // points into five. The spec fixes this order so the bound means one thing.
  const length = measureLength(text, unit);
  if (typeof config.min_length === 'number' && length < config.min_length) {
    return fail('length_out_of_bounds', `length ${length} is below the minimum of ${config.min_length}`, {
      length,
    });
  }
  if (typeof config.max_length === 'number' && length > config.max_length) {
    return fail('length_out_of_bounds', `length ${length} exceeds the maximum of ${config.max_length}`, {
      length,
    });
  }

  const lines = countLines(text);
  if (typeof config.min_lines === 'number' && lines < config.min_lines) {
    return fail(
      'line_count_out_of_bounds',
      `line count ${lines} is below the minimum of ${config.min_lines}`,
      { lines },
    );
  }
  if (typeof config.max_lines === 'number' && lines > config.max_lines) {
    return fail(
      'line_count_out_of_bounds',
      `line count ${lines} exceeds the maximum of ${config.max_lines}`,
      { lines },
    );
  }

  const caseSensitive = config.case_sensitive ?? true;
  const haystack = caseSensitive ? text : text.toLowerCase();

  // The needle goes through the same normalisation as the haystack, so a required
  // substring written in one composition form is found in the other.
  const prepare = (needle: string): string => {
    const probe = applyUnicodeNormalization(needle, form);
    return caseSensitive ? probe : probe.toLowerCase();
  };

  for (const needle of config.required_substrings ?? []) {
    const probe = prepare(needle);
    if (!haystack.includes(probe)) {
      return fail(
        'missing_required_substring',
        `required substring ${JSON.stringify(needle)} is absent`,
        { substring: needle },
      );
    }
  }
  for (const needle of config.forbidden_substrings ?? []) {
    const probe = prepare(needle);
    if (haystack.includes(probe)) {
      return fail(
        'forbidden_substring_present',
        `forbidden substring ${JSON.stringify(needle)} is present`,
        { substring: needle },
      );
    }
  }
  return ok();
}

// ------------------------------------------------------------------ registry

/** The executable tier. Defined here rather than in the registry so that a verifier list
 *  can refuse it without importing its own consumer. */
export const EXECUTABLE_VERIFIER_TYPES = ['sympy_equiv', 'python_unittest'] as const;

type DeclarativeHandler = (config: never, candidate: string) => Verdict;

export const DECLARATIVE_VERIFIERS: Record<string, DeclarativeHandler> = {
  exact: verifyExact as DeclarativeHandler,
  numeric_tolerance: verifyNumericTolerance as DeclarativeHandler,
  json_schema: verifyJsonSchema as DeclarativeHandler,
  regex: verifyRegex as DeclarativeHandler,
  set_equality: verifySetEquality as DeclarativeHandler,
  ordered_equality: verifyOrderedEquality as DeclarativeHandler,
  format_constraint: verifyFormatConstraint as DeclarativeHandler,
};

export const DECLARATIVE_VERIFIER_TYPES = Object.keys(DECLARATIVE_VERIFIERS);
