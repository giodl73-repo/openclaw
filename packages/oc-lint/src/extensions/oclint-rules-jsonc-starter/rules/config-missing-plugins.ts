/**
 * Rule: `jsonc-starter-v0/config/missing-plugins`
 * Severity: info
 * Applies to: *.jsonc
 *
 * Flag: a config file lacks a top-level `plugins` key. Almost every
 * openclaw config has at least an empty plugins block; missing means
 * authoring-in-progress or wrong-file.
 *
 * **Teaching pattern**: this rule uses the universal `resolveOcPath`
 * to check existence of the address. No direct AST traversal needed
 * for a simple presence check.
 */
import { parseOcPath, resolveOcPath } from '@openclaw/oc-path';
import type { LintRule } from '../../../plugin-sdk/oc-lint/types.js';

export const configMissingPlugins: LintRule = {
  id: 'jsonc-starter-v0/config/missing-plugins',
  severity: 'info',
  description: 'config file lacks a top-level `plugins` key',
  // Narrow to openclaw-named configs so we don't flag tsconfig.jsonc or
  // similar non-openclaw .jsonc files. Operators with a custom config
  // filename can register the rule directly with their own appliesTo.
  appliesTo: '{gateway,openclaw,config}*.jsonc',
  check(ctx) {
    const m = resolveOcPath(ctx.ast, parseOcPath(`oc://${ctx.fileName}/plugins`));
    if (m !== null) return [];
    // Anchor at the root object's line — that's where the missing key
    // would be inserted. Falls back to 1 for empty / non-object roots.
    const rootLine =
      ctx.ast.kind === 'jsonc' ? ctx.ast.root?.line ?? 1 : 1;
    return [
      {
        message: `${ctx.fileName}: missing top-level \`plugins\` key`,
        ocPath: `oc://${ctx.fileName}/plugins`,
        line: rootLine,
        fixHint: 'add a top-level `"plugins": { "entries": {} }` block',
      },
    ];
  },
};
