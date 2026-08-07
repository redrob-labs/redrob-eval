export type ModuleId =
  | 'compare'
  | 'evolve'
  | 'deploy'
  /** Titlebar destination, not part of the module loop nav */
  | 'settings';

export type ModuleDef = {
  id: ModuleId;
  href: string;
  label: string;
};

/** Compare decides, Evolve optimizes, Deploy serves. Settings lives in the titlebar. */
export const MODULES: ModuleDef[] = [
  { id: 'compare', href: '/compare', label: 'Compare' },
  { id: 'evolve', href: '/evolve', label: 'Evolve' },
  { id: 'deploy', href: '/deploy', label: 'Deploy' },
];
