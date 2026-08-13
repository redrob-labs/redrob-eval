import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadStubToolCatalog } from '../tool-routing/fixtures';

import type { LoadedScenario, MultiTurnLanguage, MultiTurnScenario } from './types';

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * The scripted conversations, with tool definitions resolved.
 *
 * Tools come from the tool-routing catalog rather than a second copy: a
 * multi-turn score is only readable against the single-turn one if both were
 * offered the same tools with the same descriptions.
 */
export function loadMultiTurnScenarios(): LoadedScenario[] {
  const raw = readFileSync(join(FIXTURES_DIR, 'fixtures', 'scenarios.json'), 'utf8');
  const parsed = JSON.parse(raw) as MultiTurnScenario[];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('scenarios.json must be a non-empty array');
  }

  const byName = new Map(loadStubToolCatalog().map((tool) => [tool.name, tool]));

  return parsed.map((scenario) => {
    if (scenario.turns.length === 0) {
      throw new Error(`${scenario.id}: a scenario needs at least one turn`);
    }
    if (!scenario.turns[0]!.user) {
      throw new Error(`${scenario.id}: the first turn has to be something the user says`);
    }
    const tools = (scenario.toolNames ?? []).map((name) => {
      const tool = byName.get(name);
      // A typo would quietly shrink the toolset and flatter the score.
      if (!tool) throw new Error(`${scenario.id}: unknown tool "${name}"`);
      return tool;
    });
    if (scenario.kind === 'tool' && tools.length === 0) {
      throw new Error(`${scenario.id}: a tool scenario has to offer tools`);
    }
    return { ...scenario, tools };
  });
}

export function multiTurnScenariosFor(
  languages: MultiTurnLanguage[],
): LoadedScenario[] {
  const wanted = new Set(languages);
  return loadMultiTurnScenarios().filter((s) => wanted.has(s.language));
}
