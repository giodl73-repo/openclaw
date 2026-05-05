/**
 * Fixer: `starter-v0/agents/seed-tools-todo`
 * Pairs with: `starter-v0/agents/empty-tools-section`
 *
 * Adds a TODO placeholder bullet to a `## Tools` section that exists
 * but has no items. The placeholder is unambiguously incorrect, so
 * operators can't accidentally treat it as real config.
 *
 * **Idempotency**: a section with at least one item (including the
 * TODO bullet) is left alone on subsequent runs.
 */
import { parseOcPath } from '@openclaw/oc-path';
import type { OcPathFixerSpec } from '../../../plugin-sdk/oc-doctor/types.js';

export interface SeedToolsTodoOptions {
  readonly placeholder: string;
}

const DEFAULTS: SeedToolsTodoOptions = {
  placeholder: '- TODO: list a tool here (e.g. `gh: GitHub CLI`)',
};

export const agentsSeedToolsTodo: OcPathFixerSpec<SeedToolsTodoOptions> = {
  id: 'starter-v0/agents/seed-tools-todo',
  description: 'Seed an empty ## Tools section with a TODO placeholder bullet',
  severity: 'info',
  appliesTo: 'AGENTS.md',
  defaultOptions: DEFAULTS,

  detect({ ast }) {
    if (ast.kind !== 'md') return [];
    const tools = ast.blocks.find((b) => b.slug === 'tools');
    if (tools === undefined) return [];
    if (tools.items.length > 0) return [];
    return [
      {
        match: {
          path: parseOcPath('oc://AGENTS.md/tools/+'),
          match: { kind: 'insertion-point', container: 'md-section', line: tools.line },
        },
        message: 'AGENTS.md ## Tools section has no items',
        fixHint: 'add a TODO placeholder bullet',
      },
    ];
  },

  fix({ raw, ast, options }) {
    if (ast.kind !== 'md') return raw;
    const tools = ast.blocks.find((b) => b.slug === 'tools');
    if (tools === undefined) return raw;
    if (tools.items.length > 0) return raw;

    const opts = options ?? DEFAULTS;
    // Find the line of the `## Tools` heading and inject the bullet
    // immediately after it (preserving any prose body).
    const lines = raw.split('\n');
    const headingIdx = lines.findIndex((l) => /^##\s+Tools\s*$/i.test(l));
    if (headingIdx === -1) return raw;
    // Insert bullet after the heading line + one blank line for
    // markdown-list separation.
    const before = lines.slice(0, headingIdx + 1);
    const after = lines.slice(headingIdx + 1);
    return [...before, '', opts.placeholder, ...after].join('\n');
  },
};
