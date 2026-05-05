/**
 * Rule: `jsonc-starter-v0/config/missing-version`
 * Severity: info
 * Applies to: *.jsonc
 *
 * Flag: config file lacks a top-level `version` key. Versioning the
 * config makes future migrations safer and supports the LKG-config
 * migration story.
 */
import { parseOcPath, resolveOcPath } from '@openclaw/oc-path';
import type { LintRule } from '../../../plugin-sdk/oc-lint/types.js';

export const configMissingVersion: LintRule = {
  id: 'jsonc-starter-v0/config/missing-version',
  severity: 'info',
  description: 'config file lacks a top-level `version` key',
  // Narrow to openclaw-named configs (see config-missing-plugins).
  appliesTo: '{gateway,openclaw,config}*.jsonc',
  check(ctx) {
    const m = resolveOcPath(ctx.ast, parseOcPath(`oc://${ctx.fileName}/version`));
    if (m !== null) return [];
    // Anchor at the root object's line — where the missing key would
    // be inserted. Falls back to 1 for empty / non-object roots.
    const rootLine =
      ctx.ast.kind === 'jsonc' ? ctx.ast.root?.line ?? 1 : 1;
    return [
      {
        message: `${ctx.fileName}: missing top-level \`version\` key`,
        ocPath: `oc://${ctx.fileName}/version`,
        line: rootLine,
        fixHint: 'add `"version": "1.0"` (or current schema version)',
      },
    ];
  },
};
