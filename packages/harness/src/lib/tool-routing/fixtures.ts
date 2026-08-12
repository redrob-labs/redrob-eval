import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FertilityCorpus } from './fertility';
import type {
  ToolDefinition,
  ToolRoutingLanguage,
  ToolRoutingTask,
  ToolsetId,
} from './types';
import { TOOLSETS } from './types';

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));

export function loadStubFertilityCorpus(): FertilityCorpus {
  const read = (name: string) =>
    readFileSync(join(FIXTURES_DIR, 'fixtures', name), 'utf8');
  return {
    en: read('corpus-en.txt'),
    hi: read('corpus-hi.txt'),
    'hi-Latn': read('corpus-hi-Latn.txt'),
    ko: read('corpus-ko.txt'),
  };
}

/** On-disk task shape: the toolset is named, not inlined. */
type RawToolRoutingTask = Omit<ToolRoutingTask, 'tools' | 'toolset'> & {
  /** Which named toolset to offer. Omitted means `core`. */
  toolset?: ToolsetId;
};

/** On-disk catalog: every tool that exists, plus the named subsets. */
type RawToolCatalog = {
  tools: ToolDefinition[];
  toolsets: Record<ToolsetId, string[]>;
};

function readCatalog(): RawToolCatalog {
  const raw = readFileSync(join(FIXTURES_DIR, 'fixtures', 'tool-catalog.json'), 'utf8');
  const parsed = JSON.parse(raw) as RawToolCatalog;
  if (!Array.isArray(parsed.tools) || parsed.tools.length === 0) {
    throw new Error('tool-catalog.json must define a non-empty tools array');
  }
  for (const id of TOOLSETS) {
    if (!Array.isArray(parsed.toolsets?.[id]) || parsed.toolsets[id].length === 0) {
      throw new Error(`tool-catalog.json is missing the "${id}" toolset`);
    }
  }
  return parsed;
}

/**
 * Every tool the fixtures know about. Kept in its own file because inlining a
 * JSON Schema into each of ~50 tasks would be thousands of lines of copies, and
 * a routing task is only meaningful when the distractors are the same for all.
 */
export function loadStubToolCatalog(): ToolDefinition[] {
  return readCatalog().tools;
}

/**
 * The named toolsets, resolved to definitions.
 *
 * `core` is six tools; `wide` adds near neighbours of each of them; `full` is
 * fifty tools across many domains, so a model has to read the descriptions
 * instead of picking the only plausible name.
 */
export function loadStubToolsets(): Record<ToolsetId, ToolDefinition[]> {
  const catalog = readCatalog();
  const byName = new Map(catalog.tools.map((t) => [t.name, t]));

  const resolve = (id: ToolsetId) =>
    catalog.toolsets[id].map((name) => {
      const tool = byName.get(name);
      // A typo here would silently shrink the toolset and inflate the score.
      if (!tool) throw new Error(`toolset "${id}": unknown tool "${name}"`);
      return tool;
    });

  return { core: resolve('core'), wide: resolve('wide'), full: resolve('full') };
}

export function loadStubToolRoutingTasks(): ToolRoutingTask[] {
  const raw = readFileSync(
    join(FIXTURES_DIR, 'fixtures', 'tool-tasks.json'),
    'utf8',
  );
  const parsed = JSON.parse(raw) as RawToolRoutingTask[];
  if (!Array.isArray(parsed)) {
    throw new Error('tool-tasks.json must be an array');
  }

  const toolsets = loadStubToolsets();

  return parsed.map((task) => {
    const toolset = task.toolset ?? 'core';
    const tools = toolsets[toolset];
    if (!tools) throw new Error(`${task.id}: unknown toolset "${task.toolset}"`);
    return { ...task, toolset, tools };
  });
}

export function stubTasksForLanguage(
  language: ToolRoutingLanguage,
): ToolRoutingTask[] {
  return loadStubToolRoutingTasks().filter((t) => t.language === language);
}
