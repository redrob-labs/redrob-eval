/**
 * India-specific script policy gene.
 * Applied independently to instruction, demos, and user input by the caller.
 */

export type ScriptPolicy =
  | 'native'
  | 'romanize'
  | 'normalize_to_native'
  | 'passthrough';

export const SCRIPT_POLICIES: ScriptPolicy[] = [
  'native',
  'romanize',
  'normalize_to_native',
  'passthrough',
];

/** Independent policies for prompt parts (search discovers whether they should match). */
export interface ScriptPolicyBundle {
  instruction: ScriptPolicy;
  demos: ScriptPolicy;
  input: ScriptPolicy;
}

export function defaultScriptBundle(
  policy: ScriptPolicy = 'passthrough',
): ScriptPolicyBundle {
  return { instruction: policy, demos: policy, input: policy };
}

// --- Devanagari ↔ rough Latin (Hindi-focused; other scripts → passthrough) ---

const DEV_TO_LAT: Record<string, string> = {
  '\u0905': 'a',
  '\u0906': 'aa',
  '\u0907': 'i',
  '\u0908': 'ee',
  '\u0909': 'u',
  '\u090A': 'oo',
  '\u090B': 'ri',
  '\u090F': 'e',
  '\u0910': 'ai',
  '\u0913': 'o',
  '\u0914': 'au',
  '\u0915': 'k',
  '\u0916': 'kh',
  '\u0917': 'g',
  '\u0918': 'gh',
  '\u0919': 'ng',
  '\u091A': 'ch',
  '\u091B': 'chh',
  '\u091C': 'j',
  '\u091D': 'jh',
  '\u091E': 'ny',
  '\u091F': 't',
  '\u0920': 'th',
  '\u0921': 'd',
  '\u0922': 'dh',
  '\u0923': 'n',
  '\u0924': 't',
  '\u0925': 'th',
  '\u0926': 'd',
  '\u0927': 'dh',
  '\u0928': 'n',
  '\u092A': 'p',
  '\u092B': 'ph',
  '\u092C': 'b',
  '\u092D': 'bh',
  '\u092E': 'm',
  '\u092F': 'y',
  '\u0930': 'r',
  '\u0932': 'l',
  '\u0935': 'v',
  '\u0936': 'sh',
  '\u0937': 'sh',
  '\u0938': 's',
  '\u0939': 'h',
  '\u093E': 'aa',
  '\u093F': 'i',
  '\u0940': 'ee',
  '\u0941': 'u',
  '\u0942': 'oo',
  '\u0947': 'e',
  '\u0948': 'ai',
  '\u094B': 'o',
  '\u094C': 'au',
  '\u0943': 'ri',
  '\u0902': 'n',
  '\u0903': 'h',
  '\u094D': '',
  '\u0901': 'n',
  '\u0966': '0',
  '\u0967': '1',
  '\u0968': '2',
  '\u0969': '3',
  '\u096A': '4',
  '\u096B': '5',
  '\u096C': '6',
  '\u096D': '7',
  '\u096E': '8',
  '\u096F': '9',
};

const LAT_TO_DEV: Array<[string, string]> = [
  ['aa', '\u0906'],
  ['ee', '\u0908'],
  ['oo', '\u090A'],
  ['ai', '\u0910'],
  ['au', '\u0914'],
  ['kh', '\u0916'],
  ['gh', '\u0918'],
  ['chh', '\u091B'],
  ['ch', '\u091A'],
  ['jh', '\u091D'],
  ['th', '\u0925'],
  ['dh', '\u0927'],
  ['ph', '\u092B'],
  ['bh', '\u092D'],
  ['sh', '\u0936'],
  ['ng', '\u0919'],
  ['ny', '\u091E'],
  ['a', '\u0905'],
  ['i', '\u0907'],
  ['u', '\u0909'],
  ['e', '\u090F'],
  ['o', '\u0913'],
  ['k', '\u0915'],
  ['g', '\u0917'],
  ['j', '\u091C'],
  ['t', '\u0924'],
  ['d', '\u0926'],
  ['n', '\u0928'],
  ['p', '\u092A'],
  ['b', '\u092C'],
  ['m', '\u092E'],
  ['y', '\u092F'],
  ['r', '\u0930'],
  ['l', '\u0932'],
  ['v', '\u0935'],
  ['s', '\u0938'],
  ['h', '\u0939'],
];

function hasDevanagari(text: string): boolean {
  return /[\u0900-\u097F]/.test(text);
}

function looksRomanizedIndic(text: string): boolean {
  if (hasDevanagari(text)) return false;
  return /[a-zA-Z]{2,}/.test(text);
}

export function romanizeIndic(text: string): string {
  if (!hasDevanagari(text)) return text;
  let out = '';
  for (const ch of text) {
    out += DEV_TO_LAT[ch] ?? ch;
  }
  return out;
}

export function normalizeToNative(text: string): string {
  if (hasDevanagari(text) || !looksRomanizedIndic(text)) return text;
  const lower = text.toLowerCase();
  let i = 0;
  let out = '';
  while (i < lower.length) {
    let matched = false;
    for (const [lat, dev] of LAT_TO_DEV) {
      if (lower.startsWith(lat, i)) {
        out += dev;
        i += lat.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out += text[i]!;
      i += 1;
    }
  }
  return out;
}

export function applyScriptPolicy(text: string, policy: ScriptPolicy): string {
  switch (policy) {
    case 'native':
    case 'passthrough':
      return text;
    case 'romanize':
      return romanizeIndic(text);
    case 'normalize_to_native':
      return normalizeToNative(text);
    default: {
      const _e: never = policy;
      return _e;
    }
  }
}
