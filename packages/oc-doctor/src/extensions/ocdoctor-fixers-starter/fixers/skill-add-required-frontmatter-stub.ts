/**
 * Fixer: `starter-v0/skill/add-required-frontmatter-stub`
 * Pairs with: `starter-v0/skill/missing-required-frontmatter`
 *
 * Adds stub `name:` and/or `description:` to SKILL.md frontmatter if
 * either is missing. Creates frontmatter if absent. Additive +
 * idempotent: only adds the keys that aren't already present.
 */
import { parseOcPath } from '@openclaw/oc-path';
import type { OcPathFixerSpec } from '../../../plugin-sdk/oc-doctor/types.js';

const FENCE = '---';

export const skillAddRequiredFrontmatterStub: OcPathFixerSpec = {
  id: 'starter-v0/skill/add-required-frontmatter-stub',
  description: 'Add stub `name:` / `description:` to SKILL.md frontmatter if missing',
  severity: 'info',
  tier: 'additive',
  appliesTo: 'SKILL.md',

  detect({ ast }) {
    if (ast.kind !== 'md') return [];
    const present = new Set(ast.frontmatter.map((e) => e.key));
    const missing: { key: string; fixHint: string }[] = [];
    if (!present.has('name')) missing.push({ key: 'name', fixHint: 'add `name: <skill-name>`' });
    if (!present.has('description'))
      missing.push({ key: 'description', fixHint: 'add `description: <one-sentence>`' });
    return missing.map((m) => ({
      match: {
        path: parseOcPath(`oc://SKILL.md/[frontmatter]/+${m.key}`),
        match: { kind: 'insertion-point', container: 'md-frontmatter', line: 1 } as const,
      },
      message: `SKILL.md missing required frontmatter key: ${m.key}`,
      fixHint: m.fixHint,
    }));
  },

  fix({ raw, ast }) {
    if (ast.kind !== 'md') return raw;
    const present = new Set(ast.frontmatter.map((e) => e.key));
    const additions: string[] = [];
    if (!present.has('name')) additions.push('name: TODO-skill-name');
    if (!present.has('description')) additions.push('description: TODO one-sentence');
    if (additions.length === 0) return raw;

    // Frontmatter present: insert before closing fence.
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
        const insertion = additions.map((a) => a + eol).join('');
        return raw.slice(0, before.length) + insertion + raw.slice(before.length);
      }
      return raw;
    }

    // No frontmatter: prepend a fresh block.
    return `${FENCE}\n${additions.join('\n')}\n${FENCE}\n\n${raw}`;
  },
};
