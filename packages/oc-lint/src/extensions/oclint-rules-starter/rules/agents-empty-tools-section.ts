/**
 * Rule: `starter-v0/agents/empty-tools-section`
 * Severity: info
 * Applies to: AGENTS.md
 *
 * Flag: AGENTS.md has a `## Tools` section but no items. An empty
 * tools section is usually an authoring-in-progress state; flagging
 * surfaces the gap before the agent runs against an unconfigured
 * workspace.
 */
import { findOcPaths, parseOcPath, resolveOcPath } from '@openclaw/oc-path';
import type { LintRule } from '../../../plugin-sdk/oc-lint/types.js';

export const agentsEmptyToolsSection: LintRule = {
  id: 'starter-v0/agents/empty-tools-section',
  severity: 'info',
  description: 'AGENTS.md has a ## Tools section but no items',
  appliesTo: 'AGENTS.md',
  check(ctx) {
    if (ctx.ast.kind !== 'md') return [];
    const m = resolveOcPath(ctx.ast, parseOcPath('oc://AGENTS.md/tools'));
    if (m === null) return [];
    const items = findOcPaths(ctx.ast, parseOcPath('oc://AGENTS.md/tools/*'));
    if (items.length > 0) return [];
    return [
      {
        message: 'AGENTS.md ## Tools section has no items',
        ocPath: 'oc://AGENTS.md/tools',
        line: m.line,
        fixHint: 'add at least one tool entry, e.g., `- gh: GitHub CLI`',
      },
    ];
  },
};
