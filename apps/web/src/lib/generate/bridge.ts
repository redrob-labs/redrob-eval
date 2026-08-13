import path from 'node:path';
import { probePythonBridge, type BridgeOptions } from '@redrob/harness/generate';

/**
 * Find a usable Generate bridge.
 *
 * Prefer the installed CLI (or REDROB_GENERATE_CMD). In a source checkout,
 * fall back to importing the Python package directly from `packages/generate`;
 * a researcher should not have to discover and run `pip install -e` before the
 * browser's first step works.
 */
export async function generateBridgeOptions(repoRoot: string): Promise<{
  options: BridgeOptions;
  probe: Awaited<ReturnType<typeof probePythonBridge>>;
}> {
  const configured: BridgeOptions = { cwd: repoRoot };
  const first = await probePythonBridge(configured);
  if (first.available) return { options: configured, probe: first };

  const source = path.join(repoRoot, 'packages', 'generate', 'src');
  const fallback: BridgeOptions = {
    cwd: repoRoot,
    command: process.env.PYTHON?.trim() || 'python3',
    prefixArgs: ['-c', 'from redrob_generate.cli import main; main()'],
    env: {
      ...process.env,
      PYTHONPATH: [source, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    },
  };
  const probe = await probePythonBridge(fallback);
  return { options: fallback, probe };
}
