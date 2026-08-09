// Copyright 2026 Janghoon Lee
// SPDX-License-Identifier: Apache-2.0
/**
 * Reading the template tree: what families exist, in what locales, how reviewed.
 *
 * Deliberately needs no Python. Generation does — this implementation reads and verifies
 * but does not sample — so if the catalog needed the bridge too, a workbench without it
 * would have nothing at all to show for Generate. This way the page can always list what
 * is there and be specific about which part is unavailable.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

export const TEMPLATES_DIRNAME = 'templates';
export const CORE_FILENAME = 'template.json';
export const LOCALES_DIRNAME = 'locales';

export type TranslationStatus = 'native-reviewed' | 'single-reviewer' | 'untranslated';

export interface CatalogLocale {
  tag: string;
  translationStatus: TranslationStatus;
  /** Prompt length in characters. Cheap, and enough to spot a stub that has drifted. */
  promptCharacters: number;
}

export interface CatalogTemplate {
  id: string;
  /** `id` rendered for a person. See `humanizeId`. */
  title: string;
  version: string;
  family: string;
  /** `family` with a capital, for headings. */
  familyLabel: string;
  /** Path relative to the repository root, which is what the CLI wants. */
  path: string;
  description?: string;
  /** Verifier type, or the bracketed element list when the verifier field holds a list. */
  verifierFamily: string;
  parameterCount: number;
  locales: CatalogLocale[];
}

/**
 * A machine id rendered for a person: `math.linear_equation` reads "Linear equation",
 * `language-cost-mock` reads "Language cost mock".
 *
 * Derived rather than authored. The spec has no title field, and adding one would put a
 * second name on every template that is free to drift from the id the CLI is called
 * with. The id itself stays on screen next to the title, because it is what you type.
 *
 * Sentence case, not title case: these are descriptions of a task, not proper nouns, and
 * "Quarterly Ledger Extraction" reads like a product. The leading segment of a dotted id
 * is dropped because it is the family, which is shown separately.
 */
export function humanizeId(id: string): string {
  const local = id.includes('.') ? id.slice(id.lastIndexOf('.') + 1) : id;
  const words = local.split(/[._\-\s]+/).filter(Boolean);
  if (words.length === 0) return id;
  const [first, ...rest] = words;
  return [first!.charAt(0).toUpperCase() + first!.slice(1), ...rest].join(' ');
}

export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogError';
  }
}

/**
 * Nearest ancestor of `from` holding both `templates/` and `spec/`.
 *
 * Walked rather than configured because the web app's working directory depends on
 * whether it was started from the repository root or from its own workspace, and a
 * wrong answer here shows up as an empty catalog rather than an error.
 */
export async function findRepoRoot(from: string = process.cwd()): Promise<string> {
  let current = resolve(from);
  for (;;) {
    const hasTemplates = await stat(join(current, TEMPLATES_DIRNAME))
      .then((entry) => entry.isDirectory())
      .catch(() => false);
    const hasSpec = await stat(join(current, 'spec'))
      .then((entry) => entry.isDirectory())
      .catch(() => false);
    if (hasTemplates && hasSpec) return current;
    const parent = dirname(current);
    if (parent === current) {
      throw new CatalogError(
        `could not find a directory containing both ${TEMPLATES_DIRNAME}/ and spec/ at or above ${from}`,
      );
    }
    current = parent;
  }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CatalogError(`${path} does not contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Verifier type, or the bracketed element list when the field holds a list. */
export function verifierFamilyOf(verifier: unknown): string {
  if (Array.isArray(verifier)) {
    return `[${verifier
      .map((element) => String((element as { type?: unknown } | null)?.type ?? '?'))
      .join(', ')}]`;
  }
  if (typeof verifier === 'object' && verifier !== null) {
    return String((verifier as { type?: unknown }).type ?? '?');
  }
  return 'unknown';
}

async function readFamily(
  root: string,
  coreDirectory: string,
): Promise<CatalogTemplate | undefined> {
  const corePath = join(coreDirectory, CORE_FILENAME);
  const core = await readJson(corePath).catch(() => undefined);
  if (!core) return undefined;

  const localesDirectory = join(coreDirectory, LOCALES_DIRNAME);
  const localeFiles = await readdir(localesDirectory).catch(() => [] as string[]);

  const locales: CatalogLocale[] = [];
  for (const file of localeFiles.filter((name) => name.endsWith('.json')).sort()) {
    const layer = await readJson(join(localesDirectory, file)).catch(() => undefined);
    if (!layer) continue;
    const prompt = typeof layer.prompt === 'string' ? layer.prompt : '';
    locales.push({
      tag: String(layer.locale ?? file.replace(/\.json$/, '')),
      // Not defaulted to anything friendlier. A layer without the field predates the
      // field or was written by hand, and either way nobody has said it was reviewed.
      translationStatus: (layer.translation_status as TranslationStatus) ?? 'untranslated',
      promptCharacters: prompt.length,
    });
  }

  const id = String(core.id ?? '(missing id)');
  const family = String(
    core.family ?? relative(join(root, TEMPLATES_DIRNAME), dirname(coreDirectory)),
  );

  return {
    id,
    title: humanizeId(id),
    version: String(core.version ?? '0.0.0'),
    family,
    familyLabel: humanizeId(family),
    path: relative(root, coreDirectory),
    description: typeof core.description === 'string' ? core.description : undefined,
    verifierFamily: verifierFamilyOf(core.verifier),
    parameterCount: Array.isArray(core.parameters) ? core.parameters.length : 0,
    locales,
  };
}

/**
 * Every template family under `templates/`, sorted by id.
 *
 * A family that fails to parse is skipped rather than throwing. One malformed file
 * should not blank the whole page, and the file is on disk for whoever wants to look.
 */
export async function readTemplateCatalog(root?: string): Promise<CatalogTemplate[]> {
  const repoRoot = root ?? (await findRepoRoot());
  const templatesRoot = join(repoRoot, TEMPLATES_DIRNAME);

  const templates: CatalogTemplate[] = [];
  const families = await readdir(templatesRoot, { withFileTypes: true }).catch(() => []);
  for (const family of families.filter((entry) => entry.isDirectory())) {
    const familyDirectory = join(templatesRoot, family.name);
    const names = await readdir(familyDirectory, { withFileTypes: true }).catch(() => []);
    for (const name of names.filter((entry) => entry.isDirectory())) {
      const template = await readFamily(repoRoot, join(familyDirectory, name.name));
      if (template) templates.push(template);
    }
  }
  return templates.sort((a, b) => a.id.localeCompare(b.id));
}

export interface StudyConfigSummary {
  /** Path relative to the repository root. */
  path: string;
  id: string;
  /** `id` rendered for a person. See `humanizeId`. */
  title: string;
  description?: string;
  templateCount: number;
  localeTags: string[];
  modelIds: string[];
  tokenizer: string;
  /** True when every model uses the mock provider, so running it costs nothing. */
  offline: boolean;
}

const STUDY_CONFIG_DIRECTORIES = [join('packages', 'generate', 'examples')];

/** Study configs shipped with the repository. */
export async function readStudyConfigs(root?: string): Promise<StudyConfigSummary[]> {
  const repoRoot = root ?? (await findRepoRoot());
  const configs: StudyConfigSummary[] = [];

  for (const directory of STUDY_CONFIG_DIRECTORIES) {
    const absolute = join(repoRoot, directory);
    const files = await readdir(absolute).catch(() => [] as string[]);
    for (const file of files.filter((name) => name.endsWith('.study.json')).sort()) {
      const document = await readJson(join(absolute, file)).catch(() => undefined);
      if (!document) continue;
      const models = Array.isArray(document.models) ? document.models : [];
      const locales = Array.isArray(document.locales) ? document.locales : [];
      const tokenizer = (document.fertility_tokenizer ?? {}) as Record<string, unknown>;
      const id = String(document.id ?? file);
      configs.push({
        path: join(directory, file),
        id,
        title: humanizeId(id),
        description: typeof document.description === 'string' ? document.description : undefined,
        templateCount: Array.isArray(document.templates) ? document.templates.length : 0,
        localeTags: locales.map((locale) => String((locale as { tag?: unknown }).tag ?? '?')),
        modelIds: models.map((model) => String((model as { id?: unknown }).id ?? '?')),
        tokenizer: `${String(tokenizer.name ?? '?')} ${String(tokenizer.version ?? '')}`.trim(),
        offline: models.every((model) => (model as { provider?: unknown }).provider === 'mock'),
      });
    }
  }
  return configs;
}
