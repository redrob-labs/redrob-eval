export type ModuleId =
  | 'compare'
  | 'evolve'
  | 'deploy'
  | 'generate'
  | 'analyze'
  /** Titlebar destination, not part of the module loop nav */
  | 'settings';

export type ModuleDef = {
  id: Exclude<ModuleId, 'settings'>;
  href: string;
};

/**
 * Compare decides (including tool-routing modality), Evolve optimizes, Deploy serves,
 * Generate makes the items the other modules run on. Settings lives in the titlebar.
 * Labels come from i18n (`nav.*`).
 */
export const MODULES: ModuleDef[] = [
  { id: 'compare', href: '/compare' },
  { id: 'evolve', href: '/evolve' },
  { id: 'deploy', href: '/deploy' },
  { id: 'generate', href: '/generate' },
  { id: 'analyze', href: '/analyze' },
];
