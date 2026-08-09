export type ModuleId =
  | 'compare'
  | 'evolve'
  | 'deploy'
  | 'generate'
  /** Titlebar destination, not part of the module loop nav */
  | 'settings';

export type ModuleDef = {
  id: ModuleId;
  href: string;
  label: string;
};

/**
 * Compare decides, Evolve optimizes, Deploy serves, Generate makes the items the other
 * three are run on. Settings lives in the titlebar.
 */
export const MODULES: ModuleDef[] = [
  { id: 'compare', href: '/compare', label: 'Compare' },
  { id: 'evolve', href: '/evolve', label: 'Evolve' },
  { id: 'deploy', href: '/deploy', label: 'Deploy' },
  { id: 'generate', href: '/generate', label: 'Generate' },
];
