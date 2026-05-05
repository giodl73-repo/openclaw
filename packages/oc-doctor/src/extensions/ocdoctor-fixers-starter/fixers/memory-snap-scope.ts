/**
 * Fixer: `starter-v0/memory/snap-scope`
 * Pairs with: `starter-v0/memory/invalid-scope-value`
 *
 * Snaps an invalid `scope:` frontmatter value to the package-defined
 * default (or operator-supplied target). Adds an `_auto_corrected: true`
 * frontmatter marker so the change is auditable.
 *
 * **Configurable**: caller can override `targetScope` to map invalid
 * values to a specific allowed value.
 *
 * **Risk acknowledged**: auto-correction can mask typos. Severity is
 * `warning` to surface; the `_auto_corrected` marker preserves audit
 * trail.
 */
import { parseOcPath } from '@openclaw/oc-path';
import { STARTER_ALLOWED_MEMORY_SCOPES } from '@openclaw/oc-lint';
import type { OcPathFixerSpec } from '../../../plugin-sdk/oc-doctor/types.js';

export interface SnapScopeOptions {
  readonly targetScope: string;
  readonly allowedScopes: readonly string[];
}

const DEFAULTS: SnapScopeOptions = {
  targetScope: 'default',
  allowedScopes: STARTER_ALLOWED_MEMORY_SCOPES,
};

export const memorySnapScope: OcPathFixerSpec<SnapScopeOptions> = {
  id: 'starter-v0/memory/snap-scope',
  description:
    'Snap an invalid frontmatter `scope` value to a configured target (default `default`)',
  severity: 'warning',
  appliesTo: 'MEMORY.md',
  defaultOptions: DEFAULTS,

  detect({ ast }) {
    if (ast.kind !== 'md') return [];
    const scope = ast.frontmatter.find((e) => e.key === 'scope');
    if (scope === undefined) return [];
    if (DEFAULTS.allowedScopes.includes(scope.value)) return [];
    return [
      {
        match: {
          path: parseOcPath('oc://MEMORY.md/[frontmatter]/scope'),
          match: {
            kind: 'leaf',
            valueText: scope.value,
            leafType: 'string',
            line: scope.line,
          },
        },
        message: `MEMORY.md frontmatter \`scope: ${scope.value}\` is not in allowed set`,
        fixHint: 'snap to a valid scope value',
      },
    ];
  },

  fix({ raw, ast, options }) {
    if (ast.kind !== 'md') return raw;
    const scope = ast.frontmatter.find((e) => e.key === 'scope');
    if (scope === undefined) return raw;
    const opts = options ?? DEFAULTS;
    if (opts.allowedScopes.includes(scope.value)) return raw;

    // Replace the line `scope: <invalid>` with `scope: <target>` and
    // add `_auto_corrected: true` if not already present.
    const re = new RegExp(`^(\\s*scope\\s*:\\s*).*$`, 'm');
    let next = raw.replace(re, `$1${opts.targetScope}`);
    if (!ast.frontmatter.some((e) => e.key === '_auto_corrected')) {
      // Insert `_auto_corrected: true` right after the `scope:` line.
      next = next.replace(
        /(\s*scope\s*:\s*[^\n]*\n)/,
        `$1_auto_corrected: true\n`,
      );
    }
    return next;
  },
};
