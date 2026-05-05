/**
 * Fixer: `starter-v0/memory/add-scope-default`
 * Pairs with: `starter-v0/memory/missing-frontmatter-scope`
 *
 * Adds `scope: project` to MEMORY.md frontmatter if scope is missing.
 * If frontmatter is absent, creates it. Additive + idempotent.
 */
import { parseOcPath } from '@openclaw/oc-path';
import type { OcPathFixerSpec } from '../../../plugin-sdk/oc-doctor/types.js';

const FENCE = '---';
const DEFAULT_SCOPE = 'project';

export const memoryAddScopeDefault: OcPathFixerSpec = {
  id: 'starter-v0/memory/add-scope-default',
  description: 'Add `scope: project` to MEMORY.md frontmatter if missing',
  severity: 'info',
  tier: 'additive',
  appliesTo: 'MEMORY.md',

  detect({ ast }) {
    if (ast.kind !== 'md') return [];
    if (ast.frontmatter.some((e) => e.key === 'scope')) return [];
    return [
      {
        match: {
          path: parseOcPath('oc://MEMORY.md/[frontmatter]/+scope'),
          match: { kind: 'insertion-point', container: 'md-frontmatter', line: 1 },
        },
        message: 'MEMORY.md has no `scope:` frontmatter entry',
        fixHint: 'add `scope: project` to the frontmatter',
      },
    ];
  },

  fix({ raw, ast }) {
    if (ast.kind !== 'md') return raw;
    if (ast.frontmatter.some((e) => e.key === 'scope')) return raw;

    // Frontmatter present: insert scope before closing fence.
    if (raw.startsWith(FENCE + '\n') || raw.startsWith(FENCE + '\r\n')) {
      const lines = raw.split(/(\r?\n)/);
      let inFm = false;
      let closingIndex = -1;
      for (let idx = 0; idx < lines.length; idx += 2) {
        const line = lines[idx]!;
        if (idx === 0 && line === FENCE) {
          inFm = true;
          continue;
        }
        if (inFm && line === FENCE) {
          closingIndex = idx;
          break;
        }
      }
      if (closingIndex !== -1) {
        const before = lines.slice(0, closingIndex).join('');
        const eol = before.includes('\r\n') ? '\r\n' : '\n';
        const insertion = `scope: ${DEFAULT_SCOPE}${eol}`;
        return raw.slice(0, before.length) + insertion + raw.slice(before.length);
      }
      return raw;
    }

    // No frontmatter: prepend.
    return `${FENCE}\nscope: ${DEFAULT_SCOPE}\n${FENCE}\n\n${raw}`;
  },
};
