/**
 * Rule: `jsonl-starter-v0/session/no-terminal-event`
 * Severity: info
 * Applies to: *.jsonl
 *
 * Flag: the last value line in the log isn't a session-end marker
 * (event values `end`, `complete`, `finalized`). A non-terminal log
 * suggests the session is still in flight — relevant for LKG recovery
 * decisions (do we replay? do we mark this as the in-progress session?).
 */
import { parseOcPath, resolveOcPath } from '@openclaw/oc-path';
import type { LintRule } from '../../../plugin-sdk/oc-lint/types.js';
import { STARTER_TERMINAL_EVENT_VALUES } from '../../../shared/starter-values.js';

export const sessionNoTerminalEvent: LintRule = {
  id: 'jsonl-starter-v0/session/no-terminal-event',
  severity: 'info',
  description: 'session log final value line is not a terminal event',
  appliesTo: '{session,audit,events}*.jsonl',
  check(ctx) {
    if (ctx.ast.kind !== 'jsonl') return [];
    const m = resolveOcPath(ctx.ast, parseOcPath(`oc://${ctx.fileName}/$last/event`));
    if (m === null || m.kind !== 'leaf' || m.leafType !== 'string') return [];
    if (STARTER_TERMINAL_EVENT_VALUES.has(m.valueText)) return [];
    return [
      {
        message: `${ctx.fileName}: last event is \`${m.valueText}\` — session may still be in flight`,
        ocPath: `oc://${ctx.fileName}/$last/event`,
        line: m.line,
        fixHint:
          'append `{"event":"end"}` when the session terminates cleanly',
      },
    ];
  },
};
