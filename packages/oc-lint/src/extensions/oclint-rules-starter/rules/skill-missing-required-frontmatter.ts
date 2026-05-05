/**
 * Rule: `starter-v0/skill/missing-required-frontmatter`
 * Severity: info
 * Applies to: SKILL.md
 *
 * Flag: SKILL.md missing `name` or `description` frontmatter. Upstream
 * openclaw's manifest loader at `src/plugins/manifest.ts:325+` already
 * reads these mechanically, but a missing field surfaces as a runtime
 * load failure rather than a workspace-time lint hit. This rule
 * surfaces the issue at lint time.
 *
 * **Teaching pattern**: frontmatter keys are addressable as
 * `oc://X/[frontmatter]/key`; per-key existence via `resolveOcPath`.
 */
import { parseOcPath, resolveOcPath } from '@openclaw/oc-path';
import type { LintFinding, LintRule } from '../../../plugin-sdk/oc-lint/types.js';

const REQUIRED = ['name', 'description'] as const;

export const skillMissingRequiredFrontmatter: LintRule = {
  id: 'starter-v0/skill/missing-required-frontmatter',
  severity: 'info',
  description: 'SKILL.md missing required frontmatter (name / description)',
  appliesTo: 'SKILL.md',
  check(ctx) {
    if (ctx.ast.kind !== 'md') return [];
    const findings: LintFinding[] = [];
    for (const key of REQUIRED) {
      if (resolveOcPath(ctx.ast, parseOcPath(`oc://SKILL.md/[frontmatter]/${key}`)) !== null) continue;
      // line:1 is the file-head anchor — the required frontmatter
      // key is absent, so there's no specific line to point at.
      findings.push({
        message: `SKILL.md missing required frontmatter key: ${key}`,
        ocPath: `oc://SKILL.md/[frontmatter]/${key}`,
        line: 1,
        fixHint: `add \`${key}: <value>\` to the frontmatter`,
      });
    }
    return findings;
  },
};
