/**
 * Fail if rendered output / export contains currency symbols or obvious money amounts.
 * Absolute currency must never appear in UI or exports.
 */
const CURRENCY_RE =
  /(?:^|[^A-Za-z])(?:USD|EUR|GBP|INR|JPY)\b|[$€£¥₩₹]/u;

export function containsCurrency(text: string): boolean {
  return CURRENCY_RE.test(text);
}

export function assertNoCurrency(text: string, label = 'output'): void {
  if (containsCurrency(text)) {
    const m = text.match(CURRENCY_RE);
    throw new Error(
      `Currency symbol or code found in ${label}: ${m?.[0] ?? '?'}. Absolute currency is forbidden.`,
    );
  }
}

/** Deep-scan JSON-serializable values for currency in string leaves. */
export function assertNoCurrencyInValue(value: unknown, label = 'value'): void {
  if (typeof value === 'string') {
    assertNoCurrency(value, label);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoCurrencyInValue(v, `${label}[${i}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      // Skip internal rate fields if somehow present — still fail if $ in strings
      assertNoCurrencyInValue(v, `${label}.${k}`);
    }
  }
}
