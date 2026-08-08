// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * A JSON Schema draft 2020-12 validator over the documented keyword subset,
 * per spec section 6.1.
 *
 * Written rather than pulled in as a dependency, for two reasons. The workbench must
 * install and build without adding a runtime dependency for a feature that is optional
 * and off by default; and the subset is exactly the region where this and Python's
 * `jsonschema` are known to agree, so a full implementation on this side would widen
 * the surface without widening the guarantee. `spec/conformance/json_schema.json` is
 * what keeps the agreement honest.
 *
 * Anything outside the subset is rejected as a configuration error. Ignoring an
 * unsupported assertion keyword would turn a failing candidate into a passing one, and
 * would do it on one implementation only.
 */
import { compileSubsetPattern, RegexSubsetError } from './regex-subset';
import { codePointLength } from './text';
import { VerifierConfigError } from './verdict';

export const SUPPORTED_KEYWORDS = new Set([
  '$comment',
  '$defs',
  '$ref',
  '$schema',
  'additionalProperties',
  'allOf',
  'anyOf',
  'const',
  'contains',
  'default',
  'dependentRequired',
  'deprecated',
  'description',
  'enum',
  'examples',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'items',
  'maxContains',
  'maxItems',
  'maxLength',
  'maxProperties',
  'maximum',
  'minContains',
  'minItems',
  'minLength',
  'minProperties',
  'minimum',
  'multipleOf',
  'not',
  'oneOf',
  'pattern',
  'patternProperties',
  'prefixItems',
  'properties',
  'propertyNames',
  'readOnly',
  'required',
  'title',
  'type',
  'uniqueItems',
  'writeOnly',
]);

export const REJECTED_KEYWORDS = new Set([
  '$anchor',
  '$dynamicAnchor',
  '$dynamicRef',
  '$id',
  '$vocabulary',
  'contentEncoding',
  'contentMediaType',
  'contentSchema',
  'dependencies',
  'dependentSchemas',
  'else',
  'format',
  'if',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
]);

const VALID_TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'string', 'integer']);

export const MAX_DEPTH = 64;

/** Relative slack for multipleOf, so that binary floating point does not decide truth. */
const MULTIPLE_OF_SLACK = 1e-9;

export type Schema = boolean | Record<string, unknown>;

export class SchemaSubsetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaSubsetError';
  }
}

/** Walk a schema and throw on anything outside the supported subset. */
export function validateSchemaDocument(schema: unknown, path = '#', depth = 0): void {
  if (typeof schema === 'boolean') return;
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new SchemaSubsetError(`${path}: a schema must be an object or a boolean`);
  }
  if (depth > MAX_DEPTH) {
    throw new SchemaSubsetError(`${path}: schema nests deeper than ${MAX_DEPTH} levels`);
  }
  const record = schema as Record<string, unknown>;

  for (const keyword of Object.keys(record)) {
    if (REJECTED_KEYWORDS.has(keyword)) {
      throw new SchemaSubsetError(`${path}: keyword '${keyword}' is outside the supported subset`);
    }
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw new SchemaSubsetError(`${path}: keyword '${keyword}' is not recognised`);
    }
  }

  const reference = record.$ref;
  if (reference !== undefined) {
    if (typeof reference !== 'string' || !reference.startsWith('#/$defs/')) {
      throw new SchemaSubsetError(
        `${path}: only local '#/$defs/...' references are supported, got ${JSON.stringify(reference)}`,
      );
    }
  }

  const declared = record.type;
  if (declared !== undefined) {
    const names = Array.isArray(declared) ? declared : [declared];
    for (const name of names) {
      if (typeof name !== 'string' || !VALID_TYPES.has(name)) {
        throw new SchemaSubsetError(`${path}: ${JSON.stringify(name)} is not a JSON Schema type`);
      }
    }
  }

  if (typeof record.pattern === 'string') {
    try {
      compileSubsetPattern(record.pattern, 'search', []);
    } catch (error) {
      if (error instanceof RegexSubsetError) {
        throw new SchemaSubsetError(`${path}/pattern: ${error.message}`);
      }
      throw error;
    }
  }

  for (const keyword of ['not', 'contains', 'propertyNames', 'items', 'additionalProperties']) {
    if (keyword in record) validateSchemaDocument(record[keyword], `${path}/${keyword}`, depth + 1);
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    if (!(keyword in record)) continue;
    const entries = record[keyword];
    if (!Array.isArray(entries)) {
      throw new SchemaSubsetError(`${path}/${keyword}: expected an array of schemas`);
    }
    entries.forEach((entry, index) =>
      validateSchemaDocument(entry, `${path}/${keyword}/${index}`, depth + 1),
    );
  }
  for (const keyword of ['properties', 'patternProperties', '$defs']) {
    if (!(keyword in record)) continue;
    const entries = record[keyword];
    if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
      throw new SchemaSubsetError(`${path}/${keyword}: expected an object of schemas`);
    }
    for (const [name, entry] of Object.entries(entries as Record<string, unknown>)) {
      if (keyword === 'patternProperties') {
        try {
          compileSubsetPattern(name, 'search', []);
        } catch (error) {
          if (error instanceof RegexSubsetError) {
            throw new SchemaSubsetError(`${path}/${keyword}/${name}: ${error.message}`);
          }
          throw error;
        }
      }
      validateSchemaDocument(entry, `${path}/${keyword}/${name}`, depth + 1);
    }
  }
}

/** Structural equality with JSON semantics: 1 equals 1.0, and 1 does not equal true. */
export function jsonDeepEqual(left: unknown, right: unknown): boolean {
  if (left === null || right === null) return left === right;
  const leftType = typeof left;
  const rightType = typeof right;
  if (leftType === 'boolean' || rightType === 'boolean') {
    return leftType === 'boolean' && rightType === 'boolean' && left === right;
  }
  if (leftType === 'number' && rightType === 'number') return left === right;
  if (leftType === 'string' && rightType === 'string') return left === right;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, i) => jsonDeepEqual(item, right[i]));
  }
  if (leftType === 'object' && rightType === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (key) => Object.prototype.hasOwnProperty.call(b, key) && jsonDeepEqual(a[key], b[key]),
    );
  }
  return false;
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const type = typeof value;
  if (type === 'boolean' || type === 'string' || type === 'number') return type;
  return 'object';
}

function matchesType(value: unknown, name: string): boolean {
  if (name === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (name === 'number') return typeof value === 'number';
  return jsonTypeOf(value) === name;
}

function resolveRef(root: Schema, reference: string): Schema {
  const parts = reference.slice(2).split('/');
  let current: unknown = root;
  for (const part of parts) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (typeof current !== 'object' || current === null) {
      throw new SchemaSubsetError(`could not resolve ${reference}`);
    }
    current = (current as Record<string, unknown>)[key];
  }
  if (current === undefined) throw new SchemaSubsetError(`could not resolve ${reference}`);
  return current as Schema;
}

export interface SchemaViolation {
  pointer: string;
  message: string;
}

class Validator {
  private readonly violations: SchemaViolation[] = [];

  constructor(private readonly root: Schema) {}

  static run(schema: Schema, value: unknown): SchemaViolation[] {
    const validator = new Validator(schema);
    validator.check(schema, value, '');
    return validator.violations;
  }

  private record(pointer: string, message: string): void {
    this.violations.push({ pointer: pointer || '/', message });
  }

  /** Used by anyOf / oneOf / not, where a nested failure is not a top-level failure. */
  private passes(schema: Schema, value: unknown): boolean {
    const nested = new Validator(this.root);
    nested.check(schema, value, '');
    return nested.violations.length === 0;
  }

  private check(schema: Schema, value: unknown, pointer: string, depth = 0): void {
    if (schema === true) return;
    if (schema === false) {
      this.record(pointer, 'the false schema rejects every value');
      return;
    }
    if (depth > MAX_DEPTH) {
      throw new SchemaSubsetError('schema evaluation nested too deeply');
    }
    const s = schema as Record<string, unknown>;

    if (typeof s.$ref === 'string') {
      this.check(resolveRef(this.root, s.$ref), value, pointer, depth + 1);
    }

    if (s.type !== undefined) {
      const names = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
      if (!names.some((name) => matchesType(value, name))) {
        this.record(pointer, `expected type ${names.join(' or ')}, got ${jsonTypeOf(value)}`);
        return;
      }
    }

    if (Array.isArray(s.enum) && !s.enum.some((entry) => jsonDeepEqual(entry, value))) {
      this.record(pointer, 'value is not one of the enumerated values');
    }
    if ('const' in s && !jsonDeepEqual(s.const, value)) {
      this.record(pointer, `value does not equal the required constant`);
    }

    if (Array.isArray(s.allOf)) {
      (s.allOf as Schema[]).forEach((entry) => this.check(entry, value, pointer, depth + 1));
    }
    if (Array.isArray(s.anyOf) && !(s.anyOf as Schema[]).some((entry) => this.passes(entry, value))) {
      this.record(pointer, 'value does not satisfy any branch of anyOf');
    }
    if (Array.isArray(s.oneOf)) {
      const matches = (s.oneOf as Schema[]).filter((entry) => this.passes(entry, value)).length;
      if (matches !== 1) {
        this.record(pointer, `value satisfies ${matches} branches of oneOf, expected exactly 1`);
      }
    }
    if ('not' in s && this.passes(s.not as Schema, value)) {
      this.record(pointer, 'value satisfies a schema it must not satisfy');
    }

    if (typeof value === 'number') this.checkNumber(s, value, pointer);
    if (typeof value === 'string') this.checkString(s, value, pointer);
    if (Array.isArray(value)) this.checkArray(s, value, pointer, depth);
    if (jsonTypeOf(value) === 'object') {
      this.checkObject(s, value as Record<string, unknown>, pointer, depth);
    }
  }

  private checkNumber(s: Record<string, unknown>, value: number, pointer: string): void {
    if (typeof s.minimum === 'number' && value < s.minimum) {
      this.record(pointer, `${value} is below the minimum of ${s.minimum}`);
    }
    if (typeof s.maximum === 'number' && value > s.maximum) {
      this.record(pointer, `${value} exceeds the maximum of ${s.maximum}`);
    }
    if (typeof s.exclusiveMinimum === 'number' && value <= s.exclusiveMinimum) {
      this.record(pointer, `${value} is not above the exclusive minimum of ${s.exclusiveMinimum}`);
    }
    if (typeof s.exclusiveMaximum === 'number' && value >= s.exclusiveMaximum) {
      this.record(pointer, `${value} is not below the exclusive maximum of ${s.exclusiveMaximum}`);
    }
    if (typeof s.multipleOf === 'number' && s.multipleOf > 0) {
      const quotient = value / s.multipleOf;
      const nearest = Math.round(quotient);
      if (Math.abs(quotient - nearest) > MULTIPLE_OF_SLACK * Math.max(1, Math.abs(quotient))) {
        this.record(pointer, `${value} is not a multiple of ${s.multipleOf}`);
      }
    }
  }

  private checkString(s: Record<string, unknown>, value: string, pointer: string): void {
    const length = codePointLength(value);
    if (typeof s.minLength === 'number' && length < s.minLength) {
      this.record(pointer, `string length ${length} is below the minimum of ${s.minLength}`);
    }
    if (typeof s.maxLength === 'number' && length > s.maxLength) {
      this.record(pointer, `string length ${length} exceeds the maximum of ${s.maxLength}`);
    }
    if (typeof s.pattern === 'string') {
      const { regexp } = compileSubsetPattern(s.pattern, 'search', []);
      if (!regexp.test(value)) this.record(pointer, `string does not match ${s.pattern}`);
    }
  }

  private checkArray(
    s: Record<string, unknown>,
    value: unknown[],
    pointer: string,
    depth: number,
  ): void {
    if (typeof s.minItems === 'number' && value.length < s.minItems) {
      this.record(pointer, `array has ${value.length} items, fewer than ${s.minItems}`);
    }
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) {
      this.record(pointer, `array has ${value.length} items, more than ${s.maxItems}`);
    }
    if (s.uniqueItems === true) {
      for (let i = 0; i < value.length; i += 1) {
        for (let j = i + 1; j < value.length; j += 1) {
          if (jsonDeepEqual(value[i], value[j])) {
            this.record(pointer, `items ${i} and ${j} are equal but uniqueItems is set`);
          }
        }
      }
    }

    const prefix = Array.isArray(s.prefixItems) ? (s.prefixItems as Schema[]) : [];
    prefix.forEach((entry, index) => {
      if (index < value.length) this.check(entry, value[index], `${pointer}/${index}`, depth + 1);
    });
    if ('items' in s) {
      for (let index = prefix.length; index < value.length; index += 1) {
        this.check(s.items as Schema, value[index], `${pointer}/${index}`, depth + 1);
      }
    }

    if ('contains' in s) {
      const matched = value.filter((item) => this.passes(s.contains as Schema, item)).length;
      const minimum = typeof s.minContains === 'number' ? s.minContains : 1;
      if (matched < minimum) {
        this.record(pointer, `only ${matched} items match contains, fewer than ${minimum}`);
      }
      if (typeof s.maxContains === 'number' && matched > s.maxContains) {
        this.record(pointer, `${matched} items match contains, more than ${s.maxContains}`);
      }
    }
  }

  private checkObject(
    s: Record<string, unknown>,
    value: Record<string, unknown>,
    pointer: string,
    depth: number,
  ): void {
    const keys = Object.keys(value);

    if (Array.isArray(s.required)) {
      for (const key of s.required as string[]) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          this.record(pointer, `'${key}' is a required property`);
        }
      }
    }
    if (typeof s.minProperties === 'number' && keys.length < s.minProperties) {
      this.record(pointer, `object has ${keys.length} properties, fewer than ${s.minProperties}`);
    }
    if (typeof s.maxProperties === 'number' && keys.length > s.maxProperties) {
      this.record(pointer, `object has ${keys.length} properties, more than ${s.maxProperties}`);
    }
    if (s.dependentRequired && typeof s.dependentRequired === 'object') {
      for (const [trigger, dependents] of Object.entries(
        s.dependentRequired as Record<string, string[]>,
      )) {
        if (!Object.prototype.hasOwnProperty.call(value, trigger)) continue;
        for (const dependent of dependents) {
          if (!Object.prototype.hasOwnProperty.call(value, dependent)) {
            this.record(pointer, `'${dependent}' is required when '${trigger}' is present`);
          }
        }
      }
    }
    if ('propertyNames' in s) {
      for (const key of keys) {
        this.check(s.propertyNames as Schema, key, `${pointer}/${key}`, depth + 1);
      }
    }

    const properties = (s.properties ?? {}) as Record<string, Schema>;
    const patternProperties = (s.patternProperties ?? {}) as Record<string, Schema>;
    const compiledPatterns = Object.entries(patternProperties).map(
      ([source, subschema]) =>
        [compileSubsetPattern(source, 'search', []).regexp, subschema] as const,
    );

    for (const key of keys) {
      let covered = false;
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        covered = true;
        this.check(properties[key] as Schema, value[key], `${pointer}/${key}`, depth + 1);
      }
      for (const [regexp, subschema] of compiledPatterns) {
        if (regexp.test(key)) {
          covered = true;
          this.check(subschema, value[key], `${pointer}/${key}`, depth + 1);
        }
      }
      if (!covered && 'additionalProperties' in s) {
        this.check(s.additionalProperties as Schema, value[key], `${pointer}/${key}`, depth + 1);
      }
    }
  }
}

/** Validate a parsed JSON value. An empty array means the value conforms. */
export function validateInstance(schema: Schema, value: unknown): SchemaViolation[] {
  if (typeof schema !== 'boolean' && (typeof schema !== 'object' || schema === null)) {
    throw new VerifierConfigError('schema must be an object or a boolean');
  }
  return Validator.run(schema, value);
}
