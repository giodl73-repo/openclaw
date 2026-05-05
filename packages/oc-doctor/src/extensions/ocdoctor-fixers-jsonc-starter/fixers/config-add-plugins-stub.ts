/**
 * Fixer: `jsonc-starter-v0/config/add-plugins-stub`
 * Pairs with: `jsonc-starter-v0/config/missing-plugins`
 *
 * Adds a stub `"plugins": { "entries": {} }` block to a config file
 * that lacks one. Additive (never deletes existing keys) + idempotent
 * (re-running on a file that has plugins is a no-op).
 *
 * **Edit strategy**: text-level insertion before the closing `}` of the
 * top-level object — preserves comments and formatting elsewhere in
 * the file. Substrate's `setJsoncOcPath` rebuilds raw via render mode
 * which would lose comments; for additive fixes the surgical text
 * insertion is friendlier.
 */
import { parseOcPath } from '@openclaw/oc-path';
import type { OcPathFixerSpec } from '../../../plugin-sdk/oc-doctor/types.js';

export const configAddPluginsStub: OcPathFixerSpec = {
  id: 'jsonc-starter-v0/config/add-plugins-stub',
  description:
    'Add stub `"plugins": { "entries": {} }` to a jsonc config that lacks one',
  severity: 'info',
  tier: 'additive',
  appliesTo: '*.jsonc',

  detect({ ast, fileName }) {
    if (ast.kind !== 'jsonc') return [];
    if (ast.root === null || ast.root.kind !== 'object') return [];
    if (ast.root.entries.some((e) => e.key === 'plugins')) return [];
    return [
      {
        match: {
          path: parseOcPath(`oc://${fileName}/+plugins`),
          match: { kind: 'insertion-point', container: 'jsonc-object', line: ast.root.line ?? 1 },
        },
        message: `${fileName}: missing top-level \`plugins\` block`,
        fixHint: 'add stub `"plugins": { "entries": {} }`',
      },
    ];
  },

  fix({ ast, raw }) {
    if (ast.kind !== 'jsonc') return raw;
    if (ast.root === null || ast.root.kind !== 'object') return raw;
    if (ast.root.entries.some((e) => e.key === 'plugins')) return raw;

    // Find the closing `}` of the top-level object. Walk backward from
    // EOF to locate the last `}`. JSONC with comments after EOF is rare
    // enough that this is reliable for the prototype.
    const lastBrace = raw.lastIndexOf('}');
    if (lastBrace === -1) return raw;

    // If the object is empty `{}` or has zero entries, no comma needed
    // before our insertion. Otherwise, prepend a comma.
    const needsComma = ast.root.entries.length > 0;
    const insertion = `${needsComma ? ',' : ''}\n  "plugins": { "entries": {} }\n`;

    return raw.slice(0, lastBrace) + insertion + raw.slice(lastBrace);
  },
};
