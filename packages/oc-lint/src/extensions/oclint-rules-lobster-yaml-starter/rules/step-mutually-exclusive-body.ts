/**
 * Rule: `lobster-yaml-starter-v0/step/mutually-exclusive-body`
 * Severity: error
 * Applies to: *.lobster
 *
 * **Source**: openclaw/lobster issue #41 — author mixed
 * `pipeline:` with `command:` / `run:` on the same step. Lobster
 * runtime accepts only one body field per step.
 *
 * **Teaching pattern**: a single `findOcPaths` with a 4-way segment
 * union enumerates every body field on every step in one pass. Then
 * group findings by step index — any step with multiple body fields
 * present is flagged.
 */
import { findOcPaths, parseOcPath } from '@openclaw/oc-path';
import type { LintFinding, LintRule } from '../../../plugin-sdk/oc-lint/types.js';

const BODY_FIELDS: readonly string[] = ['command', 'run', 'pipeline', 'workflow'];

export const stepMutuallyExclusiveBody: LintRule = {
  id: 'lobster-yaml-starter-v0/step/mutually-exclusive-body',
  severity: 'error',
  description:
    'step has more than one body field (command/run/pipeline/workflow); only one allowed',
  appliesTo: '*.lobster',
  check(ctx) {
    if (ctx.ast.kind !== 'yaml') return [];
    // Single union pass replaces 4 separate findOcPaths calls — emits
    // every (step, body-field) tuple that exists in the workflow.
    const matches = findOcPaths(
      ctx.ast,
      parseOcPath(`oc://${ctx.fileName}/steps/*/{command,run,pipeline,workflow}`),
    );
    // Group fields by step index.
    const byStep = new Map<string, { fields: string[]; line: number }>();
    for (const { path, match } of matches) {
      const idx = path.item;
      const field = path.field;
      if (idx === undefined || field === undefined) continue;
      const entry = byStep.get(idx) ?? { fields: [], line: match.line };
      entry.fields.push(field);
      // Track the earliest body-field line for the step's diagnostic.
      if (match.line < entry.line) entry.line = match.line;
      byStep.set(idx, entry);
    }
    const out: LintFinding[] = [];
    for (const [idx, { fields, line }] of byStep) {
      if (fields.length <= 1) continue;
      // Restore canonical order (command/run/pipeline/workflow) for messaging.
      const present = BODY_FIELDS.filter((f) => fields.includes(f));
      const guidance = present.includes('pipeline')
        ? `keep \`pipeline:\` (in-process dispatch) and drop the others, OR keep \`${present.find((f) => f !== 'pipeline')}\` (shell exec) and drop \`pipeline:\``
        : `keep one of \`${present.join('\` / \`')}\` and drop the rest — they're mutually exclusive`;
      out.push({
        message: `${ctx.fileName}: step[${idx}] declares multiple body fields: ${present.join(', ')} — only one is honored at runtime`,
        ocPath: `oc://${ctx.fileName}/steps/${idx}`,
        line,
        fixHint: guidance,
      });
    }
    return out;
  },
};
