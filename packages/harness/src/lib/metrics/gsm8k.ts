/**
 * GSM8K exact match — extract the final numeric answer and compare.
 * Gold answers typically end with `#### <number>`.
 */

export interface Gsm8kResult {
  correct: boolean;
  score: number; // 0 or 1
  gold: string | null;
  prediction: string | null;
}

/** Strip common numeric formatting noise. */
export function normalizeGsm8kNumber(raw: string): string | null {
  let s = raw.trim();
  // Drop trailing punctuation / units often appended by models
  s = s.replace(/[.$]\s*$/u, '').trim();
  s = s.replace(/[,$%]/g, '');
  s = s.replace(/\s+/g, '');
  // Keep leading minus / decimal
  const m = s.match(/^-?\d+(?:\.\d+)?/);
  if (!m) return null;
  let num = m[0]!;
  // Canonicalize floats like 18.0 → 18 when integral
  if (num.includes('.')) {
    const f = Number(num);
    if (Number.isFinite(f) && Number.isInteger(f)) num = String(f);
  }
  // Strip leading zeros but keep "0"
  if (/^-?0\d+$/.test(num)) {
    num = String(Number(num));
  }
  return num;
}

/**
 * Prefer `#### <answer>` (GSM8K gold format), else last number in the text.
 */
export function extractGsm8kAnswer(text: string): string | null {
  if (!text) return null;

  const hash = text.match(/####\s*([^\n\r]+)/);
  if (hash) {
    const n = normalizeGsm8kNumber(hash[1]!);
    if (n != null) return n;
  }

  // "The answer is 18" / "final answer: 18"
  const phrase = text.match(
    /(?:the\s+)?(?:final\s+)?answer(?:\s+is)?\s*[:\s]\s*\$?\s*(-?[0-9][0-9,]*(?:\.\d+)?)/i,
  );
  if (phrase) {
    const n = normalizeGsm8kNumber(phrase[1]!);
    if (n != null) return n;
  }

  const nums = text.match(/-?[0-9][0-9,]*(?:\.\d+)?/g);
  if (!nums || nums.length === 0) return null;
  return normalizeGsm8kNumber(nums[nums.length - 1]!);
}

export function gsm8kExactMatch(gold: string, prediction: string): Gsm8kResult {
  const g = extractGsm8kAnswer(gold);
  const p = extractGsm8kAnswer(prediction);
  const correct = g != null && p != null && g === p;
  return { correct, score: correct ? 1 : 0, gold: g, prediction: p };
}

export function meanGsm8kExact(
  pairs: Array<{ gold: string; prediction: string }>,
): number {
  if (pairs.length === 0) return 0;
  let sum = 0;
  for (const pair of pairs) sum += gsm8kExactMatch(pair.gold, pair.prediction).score;
  return sum / pairs.length;
}
