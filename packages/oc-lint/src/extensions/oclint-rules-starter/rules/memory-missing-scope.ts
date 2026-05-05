/**
 * Rule: `starter-v0/memory/missing-frontmatter-scope`
 * Severity: info
 * Applies to: MEMORY.md
 *
 * Flag: MEMORY.md has no `scope:` frontmatter entry. Scope tells the
 * runtime how widely a memory entry applies (project / wave / role /
 * task / ephemeral). Missing scope means the memory plugin treats
 * everything as project-default, which is usually too broad.
 *
 * **Teaching pattern**: `resolveOcPath` on a frontmatter address.
 */
import { parseOcPath, resolveOcPath } from '@openclaw/oc-path';
import type { LintRule } from '../../../plugin-sdk/oc-lint/types.js';

export const memoryMissingScope: LintRule = {
  id: 'starter-v0/memory/missing-frontmatter-scope',
  severity: 'info',
  description: 'MEMORY.md has no `scope:` frontmatter entry',
  appliesTo: 'MEMORY.md',
  check(ctx) {
    if (ctx.ast.kind !== 'md') return [];
    if (resolveOcPath(ctx.ast, parseOcPath('oc://MEMORY.md/[frontmatter]/scope')) !== null) return [];
    // line:1 is the file-head anchor — the frontmatter `scope:` key
    // is absent, so there's no specific line to point at.
    return [
      {
        message: 'MEMORY.md has no `scope:` frontmatter entry',
        ocPath: 'oc://MEMORY.md/[frontmatter]/scope',
        line: 1,
        fixHint: 'add `scope: project` (or wave / role / task / ephemeral) to the frontmatter',
      },
    ];
  },
};
