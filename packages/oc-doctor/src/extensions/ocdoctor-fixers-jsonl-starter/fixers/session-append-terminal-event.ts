/**
 * Fixer: `jsonl-starter-v0/session/append-terminal-event`
 * Pairs with: `jsonl-starter-v0/session/no-terminal-event`
 *
 * Appends `{"event":"end","_auto":true}` to a session log whose final
 * value line isn't a terminal event. The `_auto: true` marker lets
 * downstream consumers distinguish operator-applied from organic
 * session ends.
 *
 * **Idempotency**: re-running on a log that already terminates with
 * `event: end|complete|finalized|done` is a no-op.
 */
import { parseOcPath } from '@openclaw/oc-path';
import { STARTER_TERMINAL_EVENT_VALUES } from '@openclaw/oc-lint';
import type { OcPathFixerSpec } from '../../../plugin-sdk/oc-doctor/types.js';

export const sessionAppendTerminalEvent: OcPathFixerSpec = {
  id: 'jsonl-starter-v0/session/append-terminal-event',
  description:
    'Append `{"event":"end","_auto":true}` to a session log lacking a terminal event',
  severity: 'info',
  tier: 'additive',
  appliesTo: '{session,audit,events}*.jsonl',

  detect({ ast, fileName }) {
    if (ast.kind !== 'jsonl') return [];
    let last;
    for (let i = ast.lines.length - 1; i >= 0; i--) {
      const l = ast.lines[i];
      if (l !== undefined && l.kind === 'value') {
        last = l;
        break;
      }
    }
    if (last === undefined) return [];
    if (last.value.kind !== 'object') return [];
    const evt = last.value.entries.find((e) => e.key === 'event');
    if (evt === undefined) return [];
    if (evt.value.kind !== 'string') return [];
    if (STARTER_TERMINAL_EVENT_VALUES.has(evt.value.value)) return [];
    return [
      {
        match: {
          path: parseOcPath(`oc://${fileName}/$last/event`),
          match: {
            kind: 'leaf',
            valueText: evt.value.value,
            leafType: 'string',
            line: last.line,
          },
        },
        message: `${fileName}: last event is \`${evt.value.value}\` — session may still be in flight`,
        fixHint: 'append `{"event":"end","_auto":true}`',
      },
    ];
  },

  fix({ ast, raw }) {
    if (ast.kind !== 'jsonl') return raw;
    let last;
    for (let i = ast.lines.length - 1; i >= 0; i--) {
      const l = ast.lines[i];
      if (l !== undefined && l.kind === 'value') {
        last = l;
        break;
      }
    }
    if (last === undefined) return raw;
    if (last.value.kind !== 'object') return raw;
    const evt = last.value.entries.find((e) => e.key === 'event');
    if (evt === undefined) return raw;
    if (evt.value.kind !== 'string') return raw;
    if (STARTER_TERMINAL_EVENT_VALUES.has(evt.value.value)) return raw;

    const terminator = '{"event":"end","_auto":true}';
    const sep = raw.endsWith('\n') ? '' : '\n';
    return raw + sep + terminator + '\n';
  },
};
