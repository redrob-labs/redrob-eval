/**
 * Heuristic lint for checklist / video rubrics.
 * Flags causal, predictive, and holistic rating phrasings that violate
 * process-observable binary framing. Warning only — not airtight.
 */

export interface RubricLintHit {
  pattern: string;
  excerpt: string;
}

export interface RubricLintResult {
  ok: boolean;
  warnings: RubricLintHit[];
  /** Human-readable summary for Evolve-mode surfaces */
  message: string;
}

const FLAG_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: 'why_did', re: /\bwhy\s+did\b/i },
  { id: 'what_will_happen', re: /\bwhat\s+will\s+happen\b/i },
  { id: 'predict', re: /\bpredict(?:ion|ing)?\b/i },
  { id: 'rate_1_to_10', re: /\brate\s+(?:from\s+)?1\s*(?:to|-|–|—)\s*10\b/i },
  { id: 'overall_quality', re: /\boverall\s+quality\s+score\b/i },
  { id: 'holistic_1_10', re: /\b(?:score|rate|rate\s+it)\s+(?:on\s+)?(?:a\s+)?(?:scale\s+)?(?:of\s+)?1\s*(?:to|-|–|—)\s*10\b/i },
  { id: 'causal_because', re: /\bexplain\s+why\b/i },
  { id: 'what_happens_next', re: /\bwhat\s+happens\s+next\b/i },
];

function excerptAround(text: string, index: number, len: number): string {
  const start = Math.max(0, index - 20);
  const end = Math.min(text.length, index + len + 20);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

/**
 * Lint rubric / goal text for non-observable asks.
 * Correctly decomposed checklists ("Did the operator remove heat…?") should pass.
 */
export function lintChecklistRubric(text: string): RubricLintResult {
  const warnings: RubricLintHit[] = [];
  for (const { id, re } of FLAG_PATTERNS) {
    const m = re.exec(text);
    if (m && m.index != null) {
      warnings.push({
        pattern: id,
        excerpt: excerptAround(text, m.index, m[0].length),
      });
    }
  }
  if (warnings.length === 0) {
    return {
      ok: true,
      warnings: [],
      message: 'Rubric lint: no causal/predictive/holistic rating patterns found.',
    };
  }
  return {
    ok: false,
    warnings,
    message:
      `Rubric lint warnings (${warnings.length}): checklist items must be ` +
      `observable binary process checks, not causal explanation, prediction, ` +
      `or 1-10 holistic scores. Hits: ${warnings.map((w) => w.pattern).join(', ')}.`,
  };
}
