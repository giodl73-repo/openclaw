/**
 * Rule: `jsonl-starter-v0/session/malformed-line`
 * Severity: warning
 * Applies to: *.jsonl
 *
 * Flag: every malformed line (non-blank, non-JSON-parseable) in the
 * log. Malformed lines indicate writer corruption or a process crash
 * mid-write — recoverability-relevant for LKG-tracked session logs.
 */
import type {
  LintRule,
  LintFinding,
} from '../../../plugin-sdk/oc-lint/types.js';

export const sessionMalformedLine: LintRule = {
  id: 'jsonl-starter-v0/session/malformed-line',
  severity: 'warning',
  description: 'session log contains malformed (non-JSON-parseable) lines',
  appliesTo: '{session,audit,events}*.jsonl',
  check(ctx) {
    if (ctx.ast.kind !== 'jsonl') return [];
    const out: LintFinding[] = [];
    for (const line of ctx.ast.lines) {
      if (line.kind !== 'malformed') continue;
      out.push({
        message: `${ctx.fileName}: L${line.line} is malformed`,
        ocPath: `oc://${ctx.fileName}/L${line.line}`,
        line: line.line,
        fixHint:
          'investigate writer; consider whether to discard or repair the line during recovery',
      });
    }
    return out;
  },
};
