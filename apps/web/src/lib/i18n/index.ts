import { en, type MessageKey } from './en';
import { ko } from './ko';
import type { Locale } from './locale';

export type { MessageKey };
export { en, ko };

const catalogs: Record<Locale, Record<MessageKey, string>> = { en, ko };

export function translate(
  locale: Locale,
  key: MessageKey,
  vars?: Record<string, string | number>,
): string {
  let s: string = catalogs[locale][key] ?? catalogs.en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}
