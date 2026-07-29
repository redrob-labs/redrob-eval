import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SUITES_DIR } from './fs';
import type { ImageSuite } from './types';

export async function listSuites(): Promise<ImageSuite[]> {
  let entries;
  try {
    entries = await fs.readdir(SUITES_DIR, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }

  const suites: ImageSuite[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const raw = await fs.readFile(path.join(SUITES_DIR, entry.name), 'utf8');
    const suite = JSON.parse(raw) as ImageSuite;
    if (suite.modality === 'image') suites.push(suite);
  }
  return suites.sort((a, b) => a.suite.localeCompare(b.suite));
}

export async function loadSuite(suiteId: string): Promise<ImageSuite | null> {
  const suites = await listSuites();
  return suites.find((s) => s.suite === suiteId) ?? null;
}
