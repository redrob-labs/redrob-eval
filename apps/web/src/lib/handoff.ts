/**
 * Carrying a prompt set from Generate to Compare.
 *
 * Generate exists to make items the other modules are run on, so "I have sampled these,
 * now measure models on them" is the obvious next step and was previously a copy-paste.
 * The set travels through `sessionStorage` rather than the URL because a dozen prompts do
 * not fit in a query string, and it is read once and removed so a later visit to Compare
 * does not silently re-apply a set the reader has forgotten about.
 */
export const COMPARE_PROMPTS_KEY = 'redrob:compare-prompts';

export interface ComparePromptHandoff {
  /** Shown on the run as the prompt set name, e.g. "Linear equation (en)". */
  label: string;
  /** Deterministic metric to use when every prompt carries a reference. */
  metric?: 'accuracy' | 'gsm8k_exact';
  /** Where Generate made the set, preserved into the registry run. */
  provenance?: {
    source: 'generate';
    templateId: string;
    templateVersion: string;
    templatePath: string;
    locale: string;
    seeds: string[];
  };
  /** Shape accepted by Compare's custom prompt box: `gold` is optional. */
  prompts: { id: string; input: string; gold?: string; verifier?: unknown }[];
}

export function stashComparePrompts(handoff: ComparePromptHandoff): boolean {
  try {
    sessionStorage.setItem(COMPARE_PROMPTS_KEY, JSON.stringify(handoff));
    return true;
  } catch {
    // Private-mode Safari and storage-blocked browsers. The caller falls back to the
    // download, which is the same data by another route.
    return false;
  }
}

/** Read and remove. Returns null when nothing was handed over, or it was unreadable. */
export function takeComparePrompts(): ComparePromptHandoff | null {
  try {
    const raw = sessionStorage.getItem(COMPARE_PROMPTS_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(COMPARE_PROMPTS_KEY);
    const parsed = JSON.parse(raw) as ComparePromptHandoff;
    if (!Array.isArray(parsed?.prompts) || parsed.prompts.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}
