/**
 * Fixer: `jsonc-starter-v0/config/add-version-stub`
 * Pairs with: `jsonc-starter-v0/config/missing-version`
 *
 * Adds a stub `"version": "0.0.0"` to a config file that lacks one.
 * Operator should bump the version to a real value before shipping.
 */
import { parseOcPath } from '@openclaw/oc-path';
import type { OcPathFixerSpec } from '../../../plugin-sdk/oc-doctor/types.js';

export const configAddVersionStub: OcPathFixerSpec = {
  id: 'jsonc-starter-v0/config/add-version-stub',
  description: 'Add stub `"version": "0.0.0"` to a jsonc config that lacks one',
  severity: 'info',
  tier: 'additive',
  appliesTo: '*.jsonc',

  detect({ ast, fileName }) {
    if (ast.kind !== 'jsonc') return [];
    if (ast.root === null || ast.root.kind !== 'object') return [];
    if (ast.root.entries.some((e) => e.key === 'version')) return [];
    return [
      {
        match: {
          path: parseOcPath(`oc://${fileName}/+version`),
          match: { kind: 'insertion-point', container: 'jsonc-object', line: ast.root.line ?? 1 },
        },
        message: `${fileName}: missing top-level \`version\` key`,
        fixHint: 'add stub `"version": "0.0.0"` (then bump to real value)',
      },
    ];
  },

  fix({ ast, raw }) {
    if (ast.kind !== 'jsonc') return raw;
    if (ast.root === null || ast.root.kind !== 'object') return raw;
    if (ast.root.entries.some((e) => e.key === 'version')) return raw;

    const firstBrace = raw.indexOf('{');
    if (firstBrace === -1) return raw;

    // Insert right after the opening `{`. If the object already has
    // entries, our insertion needs a trailing comma.
    const needsComma = ast.root.entries.length > 0;
    const insertion = `\n  "version": "0.0.0"${needsComma ? ',' : ''}`;

    return raw.slice(0, firstBrace + 1) + insertion + raw.slice(firstBrace + 1);
  },
};
