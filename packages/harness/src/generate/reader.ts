// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * Reading generated sets and manifests.
 *
 * TypeScript never generates, so the interesting operation here is the audit: given a
 * published set, recompute every seed from the generator version and template id in the
 * manifest and check it against what the file claims. That is the mechanism behind the
 * spec's claim that cherry-picking is structurally impossible rather than discouraged;
 * without a tool that actually performs the check, the claim is decoration.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { contentHash } from './canonical';
import { deriveSeed, seedToString } from './seed';
import type { Instance, Manifest, Template } from './spec-types.generated';

export const INSTANCES_FILENAME = 'instances.jsonl';
export const MANIFEST_FILENAME = 'manifest.json';
export const SPEC_VERSION = 'redrob-verifiable-task/v1';

export class GeneratedSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeneratedSetError';
  }
}

export interface GeneratedSet {
  directory: string;
  manifest: Manifest;
  instances: Instance[];
}

/** Parse the JSONL instance stream. Blank lines are skipped; malformed ones are not. */
export function parseInstances(text: string): Instance[] {
  const instances: Instance[] = [];
  text.split('\n').forEach((line, offset) => {
    if (line.trim() === '') return;
    try {
      instances.push(JSON.parse(line) as Instance);
    } catch (error) {
      throw new GeneratedSetError(
        `${INSTANCES_FILENAME} line ${offset + 1} is not JSON: ${(error as Error).message}`,
      );
    }
  });
  return instances;
}

export async function readGeneratedSet(directory: string): Promise<GeneratedSet> {
  let manifestText: string;
  let instancesText: string;
  try {
    manifestText = await readFile(path.join(directory, MANIFEST_FILENAME), 'utf8');
    instancesText = await readFile(path.join(directory, INSTANCES_FILENAME), 'utf8');
  } catch (error) {
    throw new GeneratedSetError(
      `${directory} is not a generated set: ${(error as NodeJS.ErrnoException).message}`,
    );
  }

  const manifest = JSON.parse(manifestText) as Manifest;
  if (manifest.spec_version !== SPEC_VERSION) {
    throw new GeneratedSetError(
      `${directory} declares spec version ${manifest.spec_version}; this reader implements ${SPEC_VERSION}`,
    );
  }
  const instances = parseInstances(instancesText);
  if (instances.length !== manifest.instance_count) {
    throw new GeneratedSetError(
      `${directory} claims ${manifest.instance_count} instances but carries ${instances.length}`,
    );
  }
  return { directory, manifest, instances };
}

/** The only fields a locale layer may set, per spec §1.2. */
export const LOCALE_ONLY_FIELDS = ['locale', 'description', 'prompt', 'notes'] as const;

/**
 * Overlay a locale layer onto the locale-neutral core.
 *
 * A translation may change the wording and nothing else, so a layer that tries to
 * redeclare parameters, derivations or the verifier is rejected rather than merged: two
 * locales of one template must sample the same values from the same seed and expect the
 * same answer, which is what makes their token counts comparable.
 */
export function mergeTemplateLayers(
  core: Record<string, unknown>,
  localeLayer: Record<string, unknown>,
): Template {
  const allowed = new Set<string>(LOCALE_ONLY_FIELDS);
  const overreach = Object.keys(localeLayer).filter((key) => !allowed.has(key));
  if (overreach.length > 0) {
    throw new GeneratedSetError(
      `a locale layer may only set ${LOCALE_ONLY_FIELDS.join(', ')}; this one also sets ${overreach.join(', ')}`,
    );
  }
  return { ...core, ...localeLayer } as unknown as Template;
}

/** Load `template.json` plus `locales/<locale>.json` and merge them. */
export async function readTemplate(directory: string, locale = 'en'): Promise<Template> {
  const core = JSON.parse(
    await readFile(path.join(directory, 'template.json'), 'utf8'),
  ) as Record<string, unknown>;
  const layer = JSON.parse(
    await readFile(path.join(directory, 'locales', `${locale}.json`), 'utf8'),
  ) as Record<string, unknown>;
  return mergeTemplateLayers(core, layer);
}

export interface SeedAuditEntry {
  instanceIndex: number;
  templateId: string;
  claimed: string;
  recomputed: string;
  matches: boolean;
}

export interface SeedAudit {
  entries: SeedAuditEntry[];
  mismatches: SeedAuditEntry[];
  ok: boolean;
}

/**
 * Recompute every instance's seed and compare it to the one the file claims.
 *
 * A mismatch means the set was not produced by the generator version it names, which is
 * what a set assembled from several runs looks like from the outside.
 */
export function auditSeeds(set: GeneratedSet): SeedAudit {
  const generatorVersion = set.manifest.generator_version;
  const entries = set.instances.map((instance) => {
    const recomputed = seedToString(
      deriveSeed(instance.template_id, instance.instance_index, generatorVersion),
    );
    return {
      instanceIndex: instance.instance_index,
      templateId: instance.template_id,
      claimed: instance.seed,
      recomputed,
      matches: instance.seed === recomputed,
    };
  });
  const mismatches = entries.filter((entry) => !entry.matches);
  return { entries, mismatches, ok: mismatches.length === 0 };
}

export interface TemplateHashAudit {
  templateId: string;
  claimed: string;
  recomputed: string;
  matches: boolean;
}

/**
 * Check a merged template against the hash a set claims for it.
 *
 * This closes the remaining gap in the seed argument: without it, a template could be
 * edited after generation and the seeds would still recompute.
 */
export function auditTemplateHash(template: Template, claimed: string): TemplateHashAudit {
  const recomputed = contentHash(template);
  return {
    templateId: template.id,
    claimed,
    recomputed,
    matches: claimed === recomputed,
  };
}

/** Every instance in the set must agree with the manifest about its template. */
export function auditManifestConsistency(set: GeneratedSet): string[] {
  const problems: string[] = [];
  const byId = new Map(set.manifest.templates.map((entry) => [entry.id, entry]));
  for (const instance of set.instances) {
    const entry = byId.get(instance.template_id);
    if (!entry) {
      problems.push(`instance ${instance.instance_index} uses template ${instance.template_id}, which the manifest does not list`);
      continue;
    }
    if (entry.content_hash !== instance.template_hash) {
      problems.push(
        `instance ${instance.instance_index} carries template hash ${instance.template_hash} but the manifest says ${entry.content_hash}`,
      );
    }
    if (entry.version !== instance.template_version) {
      problems.push(
        `instance ${instance.instance_index} carries template version ${instance.template_version} but the manifest says ${entry.version}`,
      );
    }
  }
  const indices = set.instances.map((instance) => instance.instance_index);
  const expected = indices.map((_, position) => position);
  if (JSON.stringify(indices) !== JSON.stringify(expected)) {
    problems.push('instance indices are not a contiguous run starting at zero');
  }
  return problems;
}
