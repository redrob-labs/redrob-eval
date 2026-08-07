/**
 * Absolute currency must never appear in UI copy, caveats or exports — self-hosted
 * models have no per-token price, so cost is only ever expressed as relative weight.
 */
const CURRENCY_RE = /(?:^|[^A-Za-z])(?:USD|EUR|GBP|INR|JPY)\b|[$€£¥₩₹]/u;

export function containsCurrency(text: string): boolean {
  return CURRENCY_RE.test(text);
}
