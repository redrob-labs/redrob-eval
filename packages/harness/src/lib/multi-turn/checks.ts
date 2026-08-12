import { argsExactEqual, parseToolRoutingPrediction, stripReasoning } from '../tool-routing/parse';

import type { TurnCheck, TurnCheckResult } from './types';

/**
 * Text checks are case-insensitive and whitespace-tolerant.
 *
 * A model that writes "Tuesday, 9 AM" where the fixture says "tuesday" has not
 * forgotten the constraint, and a check that says otherwise is measuring
 * formatting. Anything that needs to be exact is a regex.
 */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function contains(reply: string, needle: string): boolean {
  return normalize(reply).includes(normalize(needle));
}

/** Score one reply against one check. The reply is the raw text the model sent. */
export function runCheck(check: TurnCheck, reply: string): TurnCheckResult {
  // The trace is not the answer: a model that thinks out loud routinely
  // rehearses the wrong answer before giving the right one, and scoring the
  // whole reply would count the rehearsal.
  const answer = stripReasoning(reply).trim() || reply;

  const result = (passed: boolean, detail = ''): TurnCheckResult => ({
    check,
    passed,
    detail: passed ? '' : detail,
  });

  switch (check.kind) {
    case 'contains':
      return result(contains(answer, check.text), `missing "${check.text}"`);
    case 'absent':
      return result(!contains(answer, check.text), `should not mention "${check.text}"`);
    case 'regex': {
      const re = new RegExp(check.pattern, check.flags ?? 'i');
      return result(re.test(answer), `no match for /${check.pattern}/`);
    }
    case 'tool_call': {
      const parsed = parseToolRoutingPrediction(answer);
      if (parsed.kind !== 'call') {
        return result(false, `expected a call to ${check.tool}, got ${parsed.kind}`);
      }
      if (parsed.tool !== check.tool) {
        return result(false, `called ${parsed.tool}, expected ${check.tool}`);
      }
      if (check.arguments && !argsExactEqual(parsed.arguments, check.arguments)) {
        return result(
          false,
          `arguments ${JSON.stringify(parsed.arguments)} != ${JSON.stringify(check.arguments)}`,
        );
      }
      return result(true);
    }
    case 'absence': {
      const parsed = parseToolRoutingPrediction(answer);
      if (parsed.kind !== 'absence') {
        return result(false, `expected ${check.action}, got ${parsed.kind}`);
      }
      return result(parsed.action === check.action, `answered ${parsed.action}`);
    }
    case 'no_tool_call': {
      const parsed = parseToolRoutingPrediction(answer);
      return result(
        parsed.kind !== 'call',
        parsed.kind === 'call' ? `called ${parsed.tool} again` : '',
      );
    }
  }
}

export function runChecks(checks: TurnCheck[], reply: string): TurnCheckResult[] {
  return checks.map((check) => runCheck(check, reply));
}

/** Did the model call this tool on this reply? Used to keep the script in step. */
export function calledTool(reply: string, tool: string): boolean {
  const parsed = parseToolRoutingPrediction(stripReasoning(reply).trim() || reply);
  return parsed.kind === 'call' && parsed.tool === tool;
}
