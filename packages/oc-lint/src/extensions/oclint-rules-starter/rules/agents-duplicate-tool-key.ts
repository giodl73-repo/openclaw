/**
 * Rule: `starter-v0/agents/duplicate-tool-key`
 * Severity: info
 * Applies to: AGENTS.md
 *
 * Flag: two items in `## Tools` share the same kv key. The agent
 * reads each tool entry as a distinct item; duplicates suggest a
 * copy-paste authoring error.
 *
 * **Teaching pattern**: `findOcPaths('oc://AGENTS.md/tools/*')` returns
 * one path per item, with duplicate-slug items disambiguated to
 * `#0`/`#1`/... ordinal addressing. The rule walks the result list in
 * order and tracks the first occurrence per slug — a second match for
 * the same slug means a duplicate, and `match.line` carries the line
 * for the diagnostic.
 */
import { findOcPaths, parseOcPath } from '@openclaw/oc-path';
import type { MdAst } from '@openclaw/oc-path';
import type { LintFinding, LintRule } from '../../../plugin-sdk/oc-lint/types.js';

export const agentsDuplicateToolKey: LintRule = {
  id: 'starter-v0/agents/duplicate-tool-key',
  severity: 'info',
  description: 'AGENTS.md ## Tools has duplicate item keys',
  appliesTo: 'AGENTS.md',
  check(ctx) {
    if (ctx.ast.kind !== 'md') return [];
    const items = findOcPaths(ctx.ast, parseOcPath('oc://AGENTS.md/tools/*'));
    // path.item is either the slug (when unique) or `#N` (when the slug
    // has duplicates). In the duplicate case, recover the slug by
    // looking up the underlying item — but for tracking duplicates we
    // need a stable per-item key. Use the slug derived from the item's
    // resolved match by re-resolving at the kv-key field address.
    const seen = new Map<string, number>();
    const findings: LintFinding[] = [];
    for (const { path, match } of items) {
      // For each item, compute the duplicate-detection key. Items
      // without a kv shape (plain bullet text) use the ordinal/slug
      // directly — they're naturally distinct or naturally identical.
      const key = path.item ?? '';
      // Only items with a colliding slug emit `#N`. Re-key by slug for
      // duplicate detection: any `#N` form means at least one collision
      // exists. Group by the item's underlying slug — derive by
      // stripping the ordinal back to slug via re-resolve.
      const groupKey = key.startsWith('#') ? slugForOrdinal(ctx.ast as MdAst, key) : key;
      const firstLine = seen.get(groupKey);
      if (firstLine !== undefined) {
        findings.push({
          message: `duplicate tool key "${groupKey}" (first defined at line ${firstLine})`,
          ocPath: `oc://AGENTS.md/tools/${path.item}`,
          line: match.line,
          fixHint: 'remove the duplicate or rename one of the entries',
        });
      } else {
        seen.set(groupKey, match.line);
      }
    }
    return findings;
  },
};

function slugForOrdinal(ast: MdAst, ordinalSeg: string): string {
  // `#N` → look up the Nth item in the tools section and return its slug.
  const m = /^#(\d+)$/.exec(ordinalSeg);
  if (m === null || m[1] === undefined) return ordinalSeg;
  const n = Number(m[1]);
  const tools = ast.blocks.find((b) => b.slug === 'tools');
  return tools?.items[n]?.slug ?? ordinalSeg;
}
