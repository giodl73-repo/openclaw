/**
 * Rule: `jsonc-starter-v0/config/no-duplicate-top-level-keys`
 * Severity: warning
 * Applies to: *.jsonc (gateway/openclaw/config)
 *
 * Flag: a top-level object key appears more than once. JSONC parsers
 * silently accept duplicates and last-key-wins; the earlier value is
 * dropped from the parsed shape. Operators routinely hit this when
 * editing config by hand and copying a section to "comment it out"
 * by duplicating with edits.
 *
 * Closes openclaw#76619 — duplicate top-level keys in gateway config
 * silently override earlier values.
 *
 * Advisory-only: there's no auto-fix because removing one duplicate
 * requires operator judgment about which value is canonical. Lint
 * surfaces the conflict; operator decides.
 */
import type { LintRule, LintFinding } from '../../../plugin-sdk/oc-lint/types.js';

export const configNoDuplicateTopLevelKeys: LintRule = {
  id: 'jsonc-starter-v0/config/no-duplicate-top-level-keys',
  severity: 'warning',
  description:
    'Top-level JSONC object has a duplicate key — last-key-wins silently drops the earlier value',
  appliesTo: '{gateway,openclaw,config}*.jsonc',
  check(ctx) {
    if (ctx.ast.kind !== 'jsonc') return [];
    const root = ctx.ast.root;
    if (root === null || root.kind !== 'object') return [];
    // Group every top-level key by name; surface every key whose
    // group has > 1 entries. JsoncEntry already carries `line`; we
    // anchor the diagnostic at every duplicate occurrence after the
    // first so operators see findings on every "last-key-wins" line.
    const byKey = new Map<string, number[]>();
    for (const entry of root.entries) {
      const lines = byKey.get(entry.key) ?? [];
      lines.push(entry.line);
      byKey.set(entry.key, lines);
    }
    const findings: LintFinding[] = [];
    for (const [key, lines] of byKey.entries()) {
      if (lines.length < 2) continue;
      const sorted = [...lines].sort((a, b) => a - b);
      const firstLine = sorted[0]!;
      for (let i = 1; i < sorted.length; i++) {
        findings.push({
          message: `top-level key '${key}' appears ${lines.length} times; first at line ${firstLine}, last-key-wins drops the earlier value`,
          ocPath: `oc://${ctx.fileName}/${key}`,
          line: sorted[i]!,
          fixHint: `remove one declaration of '${key}'; keep the canonical value`,
        });
      }
    }
    return findings;
  },
};
