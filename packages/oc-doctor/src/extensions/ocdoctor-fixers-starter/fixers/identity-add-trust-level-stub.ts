/**
 * Fixer: `starter-v0/identity/add-trust-level-stub`
 * Pairs with: `starter-v0/identity/missing-trust-level`
 *
 * Adds a stub `## Trust Level` section to IDENTITY.md if absent.
 * Additive + idempotent.
 */
import { parseOcPath } from '@openclaw/oc-path';
import type { OcPathFixerSpec } from '../../../plugin-sdk/oc-doctor/types.js';

const STUB =
  '\n## Trust Level\n\nTODO: replace with one of: internal-trusted | internal-restricted | external-anonymous\n';

export const identityAddTrustLevelStub: OcPathFixerSpec = {
  id: 'starter-v0/identity/add-trust-level-stub',
  description: 'Add a stub ## Trust Level section to IDENTITY.md if missing',
  severity: 'info',
  tier: 'additive',
  appliesTo: 'IDENTITY.md',

  detect({ ast }) {
    if (ast.kind !== 'md') return [];
    if (ast.blocks.some((b) => b.slug === 'trust-level')) return [];
    return [
      {
        match: {
          path: parseOcPath('oc://IDENTITY.md/+'),
          match: { kind: 'insertion-point', container: 'md-file', line: 1 },
        },
        message: 'IDENTITY.md has no ## Trust Level section',
        fixHint: 'append a `## Trust Level` stub',
      },
    ];
  },

  fix({ raw, ast }) {
    if (ast.kind !== 'md') return raw;
    if (ast.blocks.some((b) => b.slug === 'trust-level')) return raw;
    const sep = raw.endsWith('\n') ? '' : '\n';
    return raw + sep + STUB;
  },
};
