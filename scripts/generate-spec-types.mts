/**
 * Generate TypeScript types from spec/verifiable-task-v1.schema.json.
 * Run: yarn generate:spec-types   (and `--check` in CI, which fails on drift)
 *
 * The types are derived rather than hand-written so that the schema stays the single
 * definition of every document shape. A hand-written mirror drifts the first time
 * someone edits one of the two and not the other, and the drift is invisible until a
 * generated set fails to parse on the far side.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaPath = path.join(root, 'spec', 'verifiable-task-v1.schema.json');
const outputPath = path.join(
  root,
  'packages',
  'harness',
  'src',
  'generate',
  'spec-types.generated.ts',
);

type Json = Record<string, unknown>;

const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as Json;
const defs = schema.$defs as Record<string, Json>;

/** `verifier_exact` -> `ExactVerifier`, taken from the schema's own `title`. */
const nameFor = new Map<string, string>();
for (const [key, definition] of Object.entries(defs)) {
  const title = typeof definition.title === 'string' ? definition.title : pascal(key);
  nameFor.set(key, title);
}

function pascal(value: string): string {
  return value
    .split(/[_-]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function refName(pointer: string): string {
  const key = pointer.replace('#/$defs/', '');
  const name = nameFor.get(key);
  if (!name) throw new Error(`unknown $ref ${pointer}`);
  return name;
}

function literal(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  return 'unknown';
}

function primitive(name: string): string {
  switch (name) {
    case 'string':
      return 'string';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array':
      return 'unknown[]';
    case 'object':
      return 'Record<string, unknown>';
    default:
      return 'unknown';
  }
}

function typeOf(node: unknown, indent: string): string {
  if (node === true) return 'unknown';
  if (node === false) return 'never';
  if (typeof node !== 'object' || node === null) return 'unknown';
  const definition = node as Json;

  if (typeof definition.$ref === 'string') return refName(definition.$ref);
  if (definition.const !== undefined) return literal(definition.const);
  if (Array.isArray(definition.enum)) {
    return definition.enum.map(literal).join(' | ');
  }
  if (Array.isArray(definition.oneOf)) {
    return definition.oneOf.map((entry) => typeOf(entry, indent)).join(' | ');
  }
  if (Array.isArray(definition.anyOf)) {
    return definition.anyOf.map((entry) => typeOf(entry, indent)).join(' | ');
  }

  const declared = definition.type;
  if (Array.isArray(declared)) {
    return declared.map((entry) => primitive(String(entry))).join(' | ');
  }
  if (declared === 'array') {
    return `${arrayElement(typeOf(definition.items ?? true, indent))}[]`;
  }
  if (declared === 'object' || definition.properties) {
    return objectType(definition, indent);
  }
  if (typeof declared === 'string') return primitive(declared);
  return 'unknown';
}

/** `"i" | "m"` becomes `("i" | "m")`, otherwise `T[]` would parse as `"i" | ("m"[])`. */
function arrayElement(element: string): string {
  return element.includes(' | ') ? `(${element})` : element;
}

function objectType(definition: Json, indent: string): string {
  const properties = (definition.properties ?? {}) as Record<string, unknown>;
  const required = new Set((definition.required as string[] | undefined) ?? []);
  const inner = `${indent}  `;
  const lines: string[] = [];

  for (const [key, value] of Object.entries(properties)) {
    const description =
      typeof (value as Json)?.description === 'string' ? ((value as Json).description as string) : '';
    if (description) {
      lines.push(`${inner}/** ${description.replace(/\s+/g, ' ')} */`);
    }
    const optional = required.has(key) ? '' : '?';
    lines.push(`${inner}${JSON.stringify(key)}${optional}: ${typeOf(value, inner)};`);
  }
  if (definition.additionalProperties !== false) {
    lines.push(`${inner}[key: string]: unknown;`);
  }
  if (lines.length === 0) return 'Record<string, never>';
  return `{\n${lines.join('\n')}\n${indent}}`;
}

const banner = `// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
//
// GENERATED FILE - DO NOT EDIT.
// Source: spec/verifiable-task-v1.schema.json
// Regenerate: yarn generate:spec-types
//
// Types are derived from the JSON Schema rather than written by hand, so that the
// schema stays the single definition of every document shape in the spec.
`;

const blocks: string[] = [banner];

for (const [key, definition] of Object.entries(defs)) {
  const name = nameFor.get(key) as string;
  const description =
    typeof definition.description === 'string' ? definition.description : undefined;
  if (description) {
    blocks.push(`/**\n * ${description.replace(/\s+/g, ' ').replace(/\*\//g, '*\\/')}\n */`);
  }
  blocks.push(`export type ${name} = ${typeOf(definition, '')};\n`);
}

// String enums are also emitted as runtime tuples, because a verdict code list that
// only exists at type level cannot be iterated by a conformance runner.
for (const [key, definition] of Object.entries(defs)) {
  if (!Array.isArray(definition.enum)) continue;
  if (!definition.enum.every((entry) => typeof entry === 'string')) continue;
  const name = nameFor.get(key) as string;
  const constant = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .concat('S');
  blocks.push(
    `export const ${constant} = [\n${definition.enum
      .map((entry) => `  ${JSON.stringify(entry)},`)
      .join('\n')}\n] as const satisfies readonly ${name}[];\n`,
  );
}

const generated = blocks.join('\n');
const check = process.argv.includes('--check');

if (check) {
  const existing = readFileSync(outputPath, 'utf8');
  if (existing !== generated) {
    const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12);
    console.error(
      `spec-types.generated.ts is out of date (on disk ${digest(existing)}, from schema ${digest(
        generated,
      )}). Run: yarn generate:spec-types`,
    );
    process.exit(1);
  }
  console.log(`spec-types.generated.ts matches ${path.relative(root, schemaPath)}`);
} else {
  writeFileSync(outputPath, generated, 'utf8');
  console.log(`wrote ${path.relative(root, outputPath)}`);
}
