/**
 * Rule: `starter-v0/agents/missing-boundaries`
 * Severity: info
 * Applies to: AGENTS.md
 *
 * Flag: AGENTS.md has no `## Boundaries` section. Boundaries are the
 * authoritative deny-rule set the agent reads; their absence is a
 * common authoring mistake worth surfacing.
 *
 * **Teaching pattern**: section existence is exactly what
 * `resolveOcPath` answers — null means "no such address".
 */
import { parseOcPath, resolveOcPath } from '@openclaw/oc-path';
import type { LintRule } from '../../../plugin-sdk/oc-lint/types.js';

export const agentsMissingBoundaries: LintRule = {
  id: 'starter-v0/agents/missing-boundaries',
  severity: 'info',
  description: 'AGENTS.md has no ## Boundaries section',
  appliesTo: 'AGENTS.md',
  check(ctx) {
    if (ctx.ast.kind !== 'md') return [];
    if (resolveOcPath(ctx.ast, parseOcPath('oc://AGENTS.md/Boundaries')) !== null) return [];
    // line:1 is the file-head anchor — the section is absent, so
    // there's no specific line to point at.
    return [
      {
        message: 'AGENTS.md has no ## Boundaries section',
        ocPath: 'oc://AGENTS.md',
        line: 1,
        fixHint: 'add a `## Boundaries` section listing what the agent must NOT do',
      },
    ];
  },
};
