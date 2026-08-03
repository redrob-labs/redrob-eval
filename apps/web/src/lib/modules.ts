export type ModuleId =
  | 'home'
  | 'evolve'
  | 'text'
  | 'image'
  | 'compare'
  | 'preference';

export type AppMode = 'text' | 'image' | 'evolve';

export type ModuleDef = {
  id: ModuleId;
  href: string;
  label: string;
  blurb: string;
  /** Shown in titlebar nav (home omitted) */
  nav: boolean;
  /** Small nav chip (e.g. Preview) */
  badge?: string;
};

/** Nav order matches the product loop: Decide → Optimize → Evidence. */
export const MODULES: ModuleDef[] = [
  {
    id: 'compare',
    href: '/compare',
    label: 'Compare',
    blurb: 'Multi-axis shortlist: quality, preference, relative cost, latency.',
    nav: true,
  },
  {
    id: 'evolve',
    href: '/evolve',
    label: 'Evolve',
    blurb: 'GEPA search under a quality floor — cheapest config that clears the bar.',
    nav: true,
  },
  {
    id: 'preference',
    href: '/preference',
    label: 'Preference',
    blurb: 'Task-grounded generation for blind pairwise votes (Stage 1 — preview).',
    nav: true,
    badge: 'Preview',
  },
  {
    id: 'text',
    href: '/route',
    label: 'Route',
    blurb: 'Dual-eval small+large routing labels for outcome-supervised collection.',
    nav: true,
  },
  {
    id: 'image',
    href: '/image',
    label: 'Image',
    blurb: 'Side-by-side SFW image prefs (+ optional vision auto-judge).',
    nav: true,
  },
];

export function moduleById(id: ModuleId): ModuleDef | undefined {
  return MODULES.find((m) => m.id === id);
}
