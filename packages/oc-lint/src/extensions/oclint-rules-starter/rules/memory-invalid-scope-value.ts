/**
 * Rule: `starter-v0/memory/invalid-scope-value`
 * Severity: info
 * Applies to: MEMORY.md
 *
 * Flag: MEMORY.md has a `scope:` frontmatter entry, but its value
 * isn't one of the recognized scopes.
 */
import { parseOcPath, resolveOcPath } from '@openclaw/oc-path';
import { STARTER_ALLOWED_MEMORY_SCOPES } from '../../../shared/starter-values.js';
import type { LintRule } from '../../../plugin-sdk/oc-lint/types.js';

export const memoryInvalidScopeValue: LintRule = {
  id: 'starter-v0/memory/invalid-scope-value',
  severity: 'info',
  description: `MEMORY.md \`scope:\` is not one of ${STARTER_ALLOWED_MEMORY_SCOPES.join('/')}`,
  appliesTo: 'MEMORY.md',
  // Speculative: the scope vocabulary is workspace-convention
  // dependent. The shared default
  // (`STARTER_ALLOWED_MEMORY_SCOPES`) covers the openclaw memory
  // plugin's expected enum, but operators may extend it. Re-evaluate
  // after community signal — possibly should accept an operator-
  // supplied vocabulary instead of a fixed enum.
  status: 'speculative',
  check(ctx) {
    if (ctx.ast.kind !== 'md') return [];
    const m = resolveOcPath(ctx.ast, parseOcPath('oc://MEMORY.md/[frontmatter]/scope'));
    if (m === null || m.kind !== 'leaf') return [];
    if (STARTER_ALLOWED_MEMORY_SCOPES.includes(m.valueText)) return [];
    return [
      {
        message: `MEMORY.md scope: "${m.valueText}" is not one of ${STARTER_ALLOWED_MEMORY_SCOPES.join(', ')}`,
        ocPath: 'oc://MEMORY.md/[frontmatter]/scope',
        line: m.line,
        fixHint: `change to one of: ${STARTER_ALLOWED_MEMORY_SCOPES.join(', ')}`,
      },
    ];
  },
};
