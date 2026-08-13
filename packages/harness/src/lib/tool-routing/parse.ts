import type { AbsenceAction, ParsedPrediction } from './types';

const REASONING_OPEN = '<think>';
const REASONING_CLOSE = '</think>';

/**
 * Drop a reasoning trace so only the answer is scored.
 *
 * Some models always think before answering, and the trace routinely rehearses
 * the JSON it is about to emit. Scoring the whole reply would either read a
 * draft as the answer or, more often, fail to parse because the reply holds two
 * objects with prose between them. An unclosed block means the token budget ran
 * out mid-thought, and there is no answer behind it.
 */
export function stripReasoning(raw: string): string {
  const close = raw.lastIndexOf(REASONING_CLOSE);
  if (close >= 0) return raw.slice(close + REASONING_CLOSE.length);
  return raw.includes(REASONING_OPEN) ? '' : raw;
}

/**
 * Drop `//` and block comments that are not inside a string.
 *
 * Several instruction-tuned models answer with a fenced block of JSON annotated
 * the way a person would write it - `"amount": 0,  // missing, cannot proceed`.
 * That is not JSON, so it threw, and the report then said "unparseable" about a
 * model that had in fact chosen a tool and filled its arguments in. Rejecting
 * the reply is still right, but the reason has to be the real one: what those
 * models got wrong on those tasks was inventing a placeholder argument instead
 * of deferring, and that is a routing failure the scores should show as one.
 *
 * String-aware, or the `//` in every URL inside an argument would be eaten.
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    const next = text[i + 1];

    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** A trailing comma left behind by a comment is still not JSON. */
function dropTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j += 1;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Every complete top-level `{...}` in the text, in the order they appear.
 *
 * Brace counting rather than first-brace-to-last-brace: a reply that mentions
 * one object and then emits another would otherwise be sliced across both and
 * fail to parse.
 */
function topLevelObjects(text: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        found.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return found;
}

function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through - the answer is wrapped in prose or a code fence */
  }

  // Comments and trailing commas are stripped only after strict parsing has
  // already failed, so a well-formed reply never goes through this path.
  const relaxed = dropTrailingCommas(stripJsonComments(trimmed));
  const candidates = [...topLevelObjects(trimmed), ...topLevelObjects(relaxed)];
  if (candidates.length === 0) throw new Error('no JSON object in response');

  // Last, not first: anything before it is preamble the model talked itself out of.
  for (const text of [...candidates].reverse()) {
    try {
      return JSON.parse(text);
    } catch {
      /* try the one before it */
    }
  }
  throw new Error('no JSON object in response');
}

function argumentsObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parse a model reply into a tool call, an absence action, or a parse error.
 * Tolerates surrounding prose, since neither condition can stop a model from
 * wrapping its JSON in a sentence or thinking out loud first.
 */
export function parseToolRoutingPrediction(rawReply: string): ParsedPrediction {
  const answer = stripReasoning(rawReply);
  // What the record carries, and therefore what the UI shows as the response.
  // A trace is not an answer, and a table of inner monologues is unreadable. An
  // unclosed trace leaves no answer at all, so the reply itself is kept there
  // rather than an empty cell that says nothing about what went wrong.
  const raw = answer.trim() || rawReply;
  let value: unknown;
  try {
    value = extractJsonObject(answer);
  } catch (error) {
    return {
      kind: 'parse_error',
      raw,
      message: error instanceof Error ? error.message : 'parse failed',
    };
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'parse_error', raw, message: 'root is not an object' };
  }

  const obj = value as Record<string, unknown>;

  if (typeof obj.action === 'string') {
    const action = obj.action.toUpperCase();
    if (action === 'BLOCK' || action === 'DEFER') {
      return { kind: 'absence', action: action as AbsenceAction, raw };
    }
    // Arguments next to a non-absence action means the model put the tool name
    // in the key reserved for BLOCK and DEFER. Still a contract failure, but
    // the call it meant is right there, so record it rather than throwing the
    // routing decision away with the wrapper.
    const args = argumentsObject(obj.arguments);
    if (args) {
      return {
        kind: 'parse_error',
        raw,
        message: `tool name in "action" instead of "tool": ${obj.action}`,
        envelope: { tool: obj.action, arguments: args },
      };
    }
    // Same mistake, one step further: the tool name is in `action` and the
    // arguments were spread across the top level instead of nested. Everything
    // that is not the action is the argument set. Still scored as a parse
    // failure - this only keeps the diagnostic honest about what was meant.
    const flattened = Object.fromEntries(
      Object.entries(obj).filter(([key]) => key !== 'action'),
    );
    if (Object.keys(flattened).length > 0) {
      return {
        kind: 'parse_error',
        raw,
        message: `tool name in "action" and arguments not nested: ${obj.action}`,
        envelope: { tool: obj.action, arguments: flattened },
      };
    }
    return { kind: 'parse_error', raw, message: `unknown action ${obj.action}` };
  }

  if (typeof obj.tool === 'string') {
    const args = argumentsObject(obj.arguments);
    if (!args) {
      return { kind: 'parse_error', raw, message: 'tool call missing arguments object' };
    }
    return { kind: 'call', tool: obj.tool, arguments: args, raw };
  }

  return { kind: 'parse_error', raw, message: 'object is neither a tool call nor an absence' };
}

/** Deep equality for argument objects (key order independent). */
export function argsExactEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k]);
    return out;
  }
  return value;
}
