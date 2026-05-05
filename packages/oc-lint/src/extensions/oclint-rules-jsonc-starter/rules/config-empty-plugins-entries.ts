/**
 * Rule: `jsonc-starter-v0/config/empty-plugins-entries`
 * Severity: info
 * Applies to: *.jsonc
 *
 * Flag: `plugins.entries` exists as an empty object. An empty entries
 * block is usually authoring-in-progress; flagging surfaces the gap
 * before the gateway runs against an unconfigured plugin set.
 */
import { findOcPaths, parseOcPath, resolveOcPath } from '@openclaw/oc-path';
import type { LintRule } from '../../../plugin-sdk/oc-lint/types.js';

export const configEmptyPluginsEntries: LintRule = {
  id: 'jsonc-starter-v0/config/empty-plugins-entries',
  severity: 'info',
  description: '`plugins.entries` is an empty object',
  appliesTo: '{gateway,openclaw,config}*.jsonc',
  // Speculative: an empty entries object may be intentional (operator
  // setting up a config skeleton, or running with no plugins). Tag
  // pending community signal — could be info-only context, not a
  // diagnostic.
  status: 'speculative',
  check(ctx) {
    if (ctx.ast.kind !== 'jsonc') return [];
    const target = parseOcPath(`oc://${ctx.fileName}/plugins.entries`);
    const m = resolveOcPath(ctx.ast, target);
    if (m === null || m.kind !== 'node' || m.descriptor !== 'jsonc-object') return [];
    const entries = findOcPaths(
      ctx.ast,
      parseOcPath(`oc://${ctx.fileName}/plugins.entries/*`),
    );
    if (entries.length > 0) return [];
    return [
      {
        message: `${ctx.fileName}: \`plugins.entries\` is empty`,
        ocPath: `oc://${ctx.fileName}/plugins.entries`,
        line: m.line,
        fixHint: 'register at least one plugin entry',
      },
    ];
  },
};
