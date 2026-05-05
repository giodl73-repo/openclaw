/**
 * Extract deny rules from `oc://SOUL.md/Boundaries`.
 *
 * Each bullet under `## Boundaries` becomes one `DenyRule`. The
 * pattern IS the contract — the policy generator considers the
 * `Boundaries` section the canonical home for deny rules; nothing
 * else in the workspace produces them by default.
 *
 * **Teaching pattern**: section enumeration is what
 * `resolveOcPath('oc://SOUL.md/Boundaries')` answers. Once the
 * section is located, its `items: AstItem[]` carry each bullet's
 * `text` and 1-based source `line`.
 *
 * @module @openclaw/policy/extractors/deny-rules-from-soul-md
 */

import { parseOcPath, resolveOcPath } from '@openclaw/oc-path';
import type { DenyRule } from '../../../plugin-sdk/policy/types.js';
import type { PolicyExtractorSpec } from '../../../plugin-sdk/policy/api.js';

const BOUNDARIES_PATH = parseOcPath('oc://SOUL.md/Boundaries');

/**
 * Reduce a free-form boundary statement to a normalized matcher
 * tag: lowercase keywords, drop punctuation, take the first 3
 * tokens with length > 3. Same shape as the legacy generator's
 * pattern reduction so existing fixtures continue to assert against
 * the same string.
 */
function tagFor(reason: string): string {
  const first = reason.split(/[.,;:]/)[0] ?? reason;
  const keywords = first
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 3);
  return keywords.length > 0 ? `*${keywords.join('*')}*` : '*';
}

export const denyRulesFromSoulMd: PolicyExtractorSpec<DenyRule> = {
  id: 'starter-v0/deny-rules/from-soul-md',
  description:
    'Extract DenyRule entries from each bullet under SOUL.md ## Boundaries',
  appliesTo: 'SOUL.md',
  requires: { sdkVersion: '0.1.0' },
  extract(ctx) {
    if (ctx.file.ast.kind !== 'md') return [];
    // Resolve the Boundaries section. The matched node descriptor is
    // `md-block`; we walk back to the AST to read its items because
    // `OcMatch` carries `{kind, descriptor, line}` not the items
    // themselves.
    const match = resolveOcPath(ctx.file.ast, BOUNDARIES_PATH);
    if (match === null) return [];
    const block = ctx.file.ast.blocks.find((b) => b.line === match.line);
    if (block === undefined) return [];
    const rules: DenyRule[] = [];
    let idx = 0;
    for (const item of block.items) {
      const reason = item.text.trim();
      if (reason.length === 0) continue;
      idx++;
      rules.push({
        id: `SOUL-${idx}`,
        when: { tag: tagFor(reason) },
        reason,
      });
    }
    return rules;
  },
};
