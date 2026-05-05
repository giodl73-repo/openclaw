/**
 * Rule: `lobster-yaml-starter-v0/step/shell-tool-collision`
 * Severity: error
 * Applies to: *.lobster
 *
 * **Source**: openclaw/lobster issues #25, #26, #41 — multiple users
 * wrote `command: openclaw.invoke ...` and got
 * `/bin/sh: 1: openclaw.invoke: not found`. The `command:` field
 * shells out; in-process tool names like `openclaw.invoke`,
 * `llm_task.invoke`, `lobster`, `llm.invoke` only resolve via
 * `pipeline:`.
 *
 * **What it flags**: a step's `command:` (or `run:`) whose first
 * whitespace-delimited token matches a known in-process tool name.
 *
 * **Teaching pattern**: a single `findOcPaths` call with a segment
 * union enumerates BOTH `command` and `run` fields across every step
 * in one pass. Each match carries `line` directly — the rule never
 * touches the per-kind AST.
 */
import { findOcPaths, parseOcPath } from '@openclaw/oc-path';
import type { LintFinding, LintRule } from '../../../plugin-sdk/oc-lint/types.js';
import { STARTER_IN_PROCESS_TOOLS } from '../../../shared/starter-values.js';

export const stepShellToolCollision: LintRule = {
  id: 'lobster-yaml-starter-v0/step/shell-tool-collision',
  severity: 'error',
  description:
    'step `command:` or `run:` references an in-process tool name that will fail at shell-exec time',
  appliesTo: '*.lobster',
  check(ctx) {
    if (ctx.ast.kind !== 'yaml') return [];
    const out: LintFinding[] = [];
    const matches = findOcPaths(
      ctx.ast,
      parseOcPath(`oc://${ctx.fileName}/steps/*/{command,run}`),
    );
    for (const { path, match } of matches) {
      if (match.kind !== 'leaf') continue;
      const cmd = match.valueText.trim();
      const firstToken = cmd.split(/\s+/)[0] ?? '';
      if (!STARTER_IN_PROCESS_TOOLS.includes(firstToken)) continue;
      const fieldName = path.field ?? '';
      out.push({
        message: `${ctx.fileName}: step[${path.item}].${fieldName} references in-process tool \`${firstToken}\` — will fail with "127: not found" at shell exec`,
        ocPath: `oc://${ctx.fileName}/steps/${path.item}/${fieldName}`,
        line: match.line,
        fixHint: `\`pipeline:\` dispatches in-process; \`${fieldName}:\` shells out and \`${firstToken}\` is not on $PATH. Rewrite the field key as \`pipeline:\` (value stays the same).`,
      });
    }
    return out;
  },
};
