/**
 * Fixer: `starter-v0/tools/add-guidance-table-stub`
 * Pairs with: `starter-v0/tools/empty-guidance-table`
 *
 * Adds a stub `## Tool Guidance` section with a placeholder table row
 * to TOOLS.md if the section is absent. (If the section exists with an
 * empty table, the paired lint rule fires but a fix is destructive —
 * we don't auto-add rows there.)
 */
import { parseOcPath } from '@openclaw/oc-path';
import type { OcPathFixerSpec } from '../../../plugin-sdk/oc-doctor/types.js';

const STUB =
  '\n## Tool Guidance\n\n| tool | guidance |\n| --- | --- |\n| TODO | TODO: describe each tool the agent uses |\n';

export const toolsAddGuidanceTableStub: OcPathFixerSpec = {
  id: 'starter-v0/tools/add-guidance-table-stub',
  description: 'Add a stub ## Tool Guidance section to TOOLS.md if missing',
  severity: 'info',
  tier: 'additive',
  appliesTo: 'TOOLS.md',

  detect({ ast }) {
    if (ast.kind !== 'md') return [];
    if (ast.blocks.some((b) => b.slug === 'tool-guidance')) return [];
    return [
      {
        match: {
          path: parseOcPath('oc://TOOLS.md/+'),
          match: { kind: 'insertion-point', container: 'md-file', line: 1 },
        },
        message: 'TOOLS.md has no ## Tool Guidance section',
        fixHint: 'append a `## Tool Guidance` stub with a placeholder table row',
      },
    ];
  },

  fix({ raw, ast }) {
    if (ast.kind !== 'md') return raw;
    if (ast.blocks.some((b) => b.slug === 'tool-guidance')) return raw;
    const sep = raw.endsWith('\n') ? '' : '\n';
    return raw + sep + STUB;
  },
};
