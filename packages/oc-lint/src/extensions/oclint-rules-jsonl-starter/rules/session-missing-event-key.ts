/**
 * Rule: `jsonl-starter-v0/session/missing-event-key`
 * Severity: info
 * Applies to: *.jsonl
 *
 * Flag: every value line should be a JSON object carrying at least an
 * `event` key (the canonical session-event shape). Lines that are
 * arrays / scalars / objects without `event` indicate a writer that
 * isn't following the convention.
 */
import type {
  LintRule,
  LintFinding,
} from '../../../plugin-sdk/oc-lint/types.js';

export const sessionMissingEventKey: LintRule = {
  id: 'jsonl-starter-v0/session/missing-event-key',
  severity: 'info',
  description: 'session log line lacks canonical `event` key',
  appliesTo: '{session,audit,events}*.jsonl',
  // Speculative: the `event` discriminator is openclaw's convention,
  // but third-party JSONL session formats may legitimately use a
  // different field name. Re-evaluate after community feedback.
  status: 'speculative',
  check(ctx) {
    if (ctx.ast.kind !== 'jsonl') return [];
    const out: LintFinding[] = [];
    for (const line of ctx.ast.lines) {
      if (line.kind !== 'value') continue;
      if (line.value.kind !== 'object') {
        out.push({
          message: `${ctx.fileName}: L${line.line} is not a JSON object`,
          ocPath: `oc://${ctx.fileName}/L${line.line}`,
          line: line.line,
          fixHint: 'session lines should be `{ "event": "...", ... }` objects',
        });
        continue;
      }
      if (!line.value.entries.some((e) => e.key === 'event')) {
        out.push({
          message: `${ctx.fileName}: L${line.line} object lacks \`event\` key`,
          ocPath: `oc://${ctx.fileName}/L${line.line}`,
          line: line.line,
          fixHint: 'add an `event` discriminator (e.g., `start`, `step`, `end`)',
        });
      }
    }
    return out;
  },
};
