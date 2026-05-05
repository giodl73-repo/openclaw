/**
 * Rule: `starter-v0/tools/empty-guidance-table`
 * Severity: info
 * Applies to: TOOLS.md
 *
 * Flag: TOOLS.md has a `## Tool Guidance` section that contains a
 * table header but no rows. The agent surfaces guidance per tool;
 * an empty guidance block is usually a setup-in-progress state.
 *
 * **Why partial kind-narrow**: section existence is a `resolveOcPath`
 * question; table-row count is content-shape introspection that the
 * universal `OcMatch` doesn't currently surface (md tables aren't
 * addressable via OcPath). Resolve gates entry; the per-kind walk
 * inspects the table.
 */
import { parseOcPath, resolveOcPath } from '@openclaw/oc-path';
import type { MdAst } from '@openclaw/oc-path';
import type { LintRule } from '../../../plugin-sdk/oc-lint/types.js';

export const toolsEmptyGuidanceTable: LintRule = {
  id: 'starter-v0/tools/empty-guidance-table',
  severity: 'info',
  description: 'TOOLS.md ## Tool Guidance table has no rows',
  appliesTo: 'TOOLS.md',
  check(ctx) {
    if (ctx.ast.kind !== 'md') return [];
    if (resolveOcPath(ctx.ast, parseOcPath('oc://TOOLS.md/tool-guidance')) === null) return [];
    const guidance = (ctx.ast as MdAst).blocks.find((b) => b.slug === 'tool-guidance');
    if (guidance === undefined || guidance.tables.length === 0) return [];
    const table = guidance.tables[0]!;
    if (table.rows.length > 0) return [];
    return [
      {
        message: 'TOOLS.md ## Tool Guidance table has no rows',
        ocPath: 'oc://TOOLS.md/tool-guidance',
        line: table.line,
        fixHint: 'add at least one tool row, e.g., `| gh | use for GitHub |`',
      },
    ];
  },
};
