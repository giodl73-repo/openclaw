/**
 * Fixer: `starter-v0/user/add-preferences-stub`
 * Pairs with: `starter-v0/user/missing-preferences-section`
 *
 * Adds a stub `## Preferences` section to USER.md if absent.
 * Additive + idempotent.
 */
import { parseOcPath } from '@openclaw/oc-path';
import type { OcPathFixerSpec } from '../../../plugin-sdk/oc-doctor/types.js';

const STUB = `\n## Preferences\n\n- TODO: list working preferences (e.g., async-first, terse responses)\n`;

export const userAddPreferencesStub: OcPathFixerSpec = {
  id: 'starter-v0/user/add-preferences-stub',
  description: 'Add a stub ## Preferences section to USER.md if missing',
  severity: 'info',
  tier: 'additive',
  appliesTo: 'USER.md',

  detect({ ast }) {
    if (ast.kind !== 'md') return [];
    if (ast.blocks.some((b) => b.slug === 'preferences')) return [];
    return [
      {
        match: {
          path: parseOcPath('oc://USER.md/+'),
          match: { kind: 'insertion-point', container: 'md-file', line: 1 },
        },
        message: 'USER.md has no ## Preferences section',
        fixHint: 'append a `## Preferences` stub',
      },
    ];
  },

  fix({ raw, ast }) {
    if (ast.kind !== 'md') return raw;
    if (ast.blocks.some((b) => b.slug === 'preferences')) return raw;
    const sep = raw.endsWith('\n') ? '' : '\n';
    return raw + sep + STUB;
  },
};
