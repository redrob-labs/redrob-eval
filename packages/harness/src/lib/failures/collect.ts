import type { MultiTurnReport } from '../multi-turn/types';
import type { ToolRoutingExampleRecord, ToolRoutingReport } from '../tool-routing/types';

import type { FailureKind, FailureRecord, FailureTally } from './types';
import { FAILURE_KINDS } from './types';

/** Shorten a reply for a table without hiding that it was cut. */
function clip(text: string, max = 400): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function renderExpected(example: ToolRoutingExampleRecord): string {
  // Prefer the recorded ground truth: "wrong arguments" is not a finding until
  // the reader can see which ones were wanted.
  const expected = example.expected;
  if (expected) {
    return expected.kind === 'absence'
      ? `{"action":"${expected.action}"}`
      : `${expected.tool} ${JSON.stringify(expected.arguments)}`;
  }
  // Reports written before the expectation was kept: say which axis failed
  // rather than inventing a fixture that may not match.
  const s = example.score;
  if (s.absenceCorrect != null) return 'an absence (BLOCK or DEFER)';
  if (s.toolSelectCorrect === false) return 'a different tool';
  if (s.argExactMatch === false) return 'the same tool with different arguments';
  return 'a valid tool call';
}

/**
 * The request, without the tool catalogue.
 *
 * A contract prompt is the same page of JSON schemas on every task; printing it
 * buries the one line that differs. The catalogue ends at the `User:` marker,
 * so anything after it is the actual request.
 */
export function promptRequest(prompt: string): string {
  const at = prompt.lastIndexOf('\nUser:');
  const request = at >= 0 ? prompt.slice(at + '\nUser:'.length) : prompt;
  return clip(request.trim(), 500);
}

/**
 * Classify one tool-routing example, most specific cause first.
 *
 * Order matters. A reply that named the right tool inside the wrong key is an
 * `envelope` failure, not a bare `format` one, and calling it `format` would
 * hide the most actionable finding in the set - that the model can route and
 * only the wrapper is wrong.
 */
export function classifyToolRoutingExample(
  example: ToolRoutingExampleRecord,
): { kind: FailureKind; detail: string } | null {
  const s = example.score;
  if (example.error) return { kind: 'call_error', detail: example.error };

  if (s.parseFailed) {
    const message = example.parsed.kind === 'parse_error' ? example.parsed.message : 'unparseable';
    if (s.envelopeError) {
      return {
        kind: 'envelope',
        detail:
          s.envelopeToolWouldMatch === true
            ? `right tool through the wrong key: ${message}`
            : `wrong wrapper, and the wrong tool inside it: ${message}`,
      };
    }
    return { kind: 'format', detail: message };
  }

  if (s.absenceCorrect === false) {
    // Expected an absence. Either it acted, or it declined the wrong way.
    if (example.parsed.kind === 'call') {
      return {
        kind: 'missed_abstention',
        detail: `called ${example.parsed.tool} where it should have declined`,
      };
    }
    const got = example.parsed.kind === 'absence' ? example.parsed.action : 'something else';
    return { kind: 'wrong_abstention', detail: `declined with ${got}` };
  }

  if (s.toolSelectCorrect === false) {
    const got = example.parsed.kind === 'call' ? example.parsed.tool : example.parsed.kind;
    return { kind: 'wrong_tool', detail: `chose ${got}` };
  }
  if (s.argExactMatch === false) {
    const got = example.parsed.kind === 'call' ? JSON.stringify(example.parsed.arguments) : '';
    return { kind: 'bad_arguments', detail: `right tool, arguments were ${clip(got, 160)}` };
  }
  return null;
}

/** Every failing example in a tool-routing report, classified. */
export function failuresFromToolRouting(
  report: ToolRoutingReport,
  context: { model?: string } = {},
): FailureRecord[] {
  const model = context.model ?? report.modelId;
  const out: FailureRecord[] = [];
  for (const example of report.examples ?? []) {
    const verdict = classifyToolRoutingExample(example);
    if (!verdict) continue;
    const record: FailureRecord = {
      id: `${model}|${example.taskId}`,
      kind: verdict.kind,
      detail: verdict.detail,
      source: 'tool-routing',
      model,
      item: example.taskId,
      language: example.language,
      expected: renderExpected(example),
      actual: clip(example.raw),
    };
    if (example.parsed.kind === 'call') record.actualTool = example.parsed.tool;
    if (example.expected?.kind === 'call') record.expectedTool = example.expected.tool;
    if (example.prompt) record.prompt = promptRequest(example.prompt);
    out.push(record);
  }
  return out;
}

/**
 * Every failing turn in a multi-turn report, classified.
 *
 * The capability the turn declared is the classification: the fixture already
 * said what that turn was there to test, so a failure of it needs no guessing.
 */
export function failuresFromMultiTurn(report: MultiTurnReport): FailureRecord[] {
  const byCapability: Record<string, FailureKind> = {
    instruction_retention: 'instruction_dropped',
    context_recall: 'context_lost',
    correction: 'correction_ignored',
    tool_call: 'wrong_tool',
    tool_use_result: 'spurious_call',
    tool_absence: 'missed_abstention',
  };

  const out: FailureRecord[] = [];
  for (const scenario of report.scenarios) {
    for (const turn of scenario.turns) {
      if (turn.passed) continue;
      let kind: FailureKind;
      let detail: string;
      if (turn.error) {
        kind = 'call_error';
        detail = turn.error;
      } else if (turn.desynced) {
        kind = 'desynced';
        detail = 'the script expected a tool call that never came';
      } else {
        kind = byCapability[turn.capability] ?? 'other';
        detail =
          turn.checks
            .filter((c) => !c.passed)
            .map((c) => c.detail)
            .join('; ') || 'the turn did not hold';
      }
      out.push({
        id: `${report.modelId}|${scenario.scenarioId}|t${turn.index}`,
        kind,
        detail,
        source: 'multi-turn',
        model: report.modelId,
        item: scenario.scenarioId,
        language: scenario.language,
        turn: turn.index,
        capability: turn.capability,
        actual: clip(turn.reply),
        prompt: clip(turn.sent, 200),
      });
    }
  }
  return out;
}

export interface FailureFilter {
  kind?: FailureKind | FailureKind[];
  model?: string;
  language?: string;
  /** Matches the expected or actual tool. */
  tool?: string;
  /** Multi-turn: only failures at this depth. */
  turn?: number;
  /** Substring of the item id, the detail, or the reply. */
  search?: string;
}

export function filterFailures(
  failures: FailureRecord[],
  filter: FailureFilter = {},
): FailureRecord[] {
  const kinds = filter.kind == null ? null : ([] as FailureKind[]).concat(filter.kind);
  return failures.filter((f) => {
    if (kinds && !kinds.includes(f.kind)) return false;
    if (filter.model && f.model !== filter.model) return false;
    if (filter.language && f.language !== filter.language) return false;
    if (filter.turn != null && f.turn !== filter.turn) return false;
    if (filter.tool && f.expectedTool !== filter.tool && f.actualTool !== filter.tool) return false;
    if (filter.search) {
      const needle = filter.search.toLowerCase();
      const hay = `${f.item} ${f.detail} ${f.actual ?? ''}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

/** How the failures break down, commonest first. Empty kinds are left out. */
export function tallyFailures(failures: FailureRecord[]): FailureTally[] {
  const counts = new Map<FailureKind, number>();
  for (const f of failures) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  return FAILURE_KINDS.filter((k) => counts.has(k))
    .map((kind) => ({
      kind,
      count: counts.get(kind)!,
      share: failures.length ? counts.get(kind)! / failures.length : 0,
    }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}
