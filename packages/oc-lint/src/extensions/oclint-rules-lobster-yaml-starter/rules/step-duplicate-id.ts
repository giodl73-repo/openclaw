/**
 * Rule: `lobster-yaml-starter-v0/step/duplicate-id`
 * Severity: error
 * Applies to: *.lobster
 *
 * **Source**: openclaw/lobster issues #76, #77 — for_each + parallel
 * specs explicitly require unique step IDs across the workflow,
 * including branch IDs in `parallel.branches`. Duplicates cause
 * runtime ambiguity in `$stepId.stdout` references.
 */
import { findOcPaths, parseOcPath } from '@openclaw/oc-path';
import type { LintFinding, LintRule } from '../../../plugin-sdk/oc-lint/types.js';

export const stepDuplicateId: LintRule = {
  id: 'lobster-yaml-starter-v0/step/duplicate-id',
  severity: 'error',
  description: 'step `id:` collides with another step in the workflow',
  appliesTo: '*.lobster',
  check(ctx) {
    if (ctx.ast.kind !== 'yaml') return [];
    const matches = findOcPaths(
      ctx.ast,
      parseOcPath(`oc://${ctx.fileName}/steps/*/id`),
    );
    const seen = new Map<string, string>();
    const out: LintFinding[] = [];
    for (const { path, match } of matches) {
      if (match.kind !== 'leaf') continue;
      const idx = path.item;
      if (idx === undefined) continue;
      const id = match.valueText;
      const prevIdx = seen.get(id);
      if (prevIdx !== undefined) {
        out.push({
          message: `${ctx.fileName}: step[${idx}].id \`${id}\` collides with step[${prevIdx}] — \`$${id}.stdout\` references will be ambiguous at runtime`,
          ocPath: `oc://${ctx.fileName}/steps/${idx}/id`,
          line: match.line,
          fixHint: `rename to a unique id (e.g. \`${id}_${idx}\`); update any \`stdin: $${id}.stdout\` refs that should target step[${idx}] instead of step[${prevIdx}]`,
        });
      } else {
        seen.set(id, idx);
      }
    }
    return out;
  },
};
