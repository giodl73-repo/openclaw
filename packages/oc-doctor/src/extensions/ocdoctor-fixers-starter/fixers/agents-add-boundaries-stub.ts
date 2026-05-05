/**
 * Fixer: `starter-v0/agents/add-boundaries-stub`
 * Pairs with: `starter-v0/agents/missing-boundaries`
 *
 * Adds a stub `## Boundaries` section to AGENTS.md if absent.
 * Additive (never deletes) + idempotent (re-running is no-op).
 */
import { parseOcPath } from '@openclaw/oc-path';
import type { OcPathFixerSpec } from '../../../plugin-sdk/oc-doctor/types.js';

const STUB = `\n## Boundaries\n\n- TODO: list deny-rules here (e.g., "never write to /etc")\n`;

export const agentsAddBoundariesStub: OcPathFixerSpec = {
  id: 'starter-v0/agents/add-boundaries-stub',
  description: 'Add a stub ## Boundaries section to AGENTS.md if missing',
  severity: 'info',
  tier: 'additive',
  appliesTo: 'AGENTS.md',

  detect({ ast }) {
    if (ast.kind !== 'md') return [];
    if (ast.blocks.some((b) => b.slug === 'boundaries')) return [];
    return [
      {
        match: {
          path: parseOcPath('oc://AGENTS.md/+'),
          match: { kind: 'insertion-point', container: 'md-file', line: 1 },
        },
        message: 'AGENTS.md has no ## Boundaries section',
        fixHint: 'append a `## Boundaries` stub',
      },
    ];
  },

  fix({ raw, ast }) {
    if (ast.kind !== 'md') return raw;
    if (ast.blocks.some((b) => b.slug === 'boundaries')) return raw;
    const sep = raw.endsWith('\n') ? '' : '\n';
    return raw + sep + STUB;
  },
};
